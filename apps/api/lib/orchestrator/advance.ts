import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import {
  ORCHESTRATOR_TURN_STOPPED_ERROR,
  OrchestratorConcurrency,
  OrchestratorConversationStatus,
  OrchestratorMessageKind,
  OrchestratorTurnEnd,
  type OrchestratorTurnResult,
  OrchestratorTurnStatus,
  orchestratorTurnResultSchema,
} from "@repo/api/src/types/orchestrator";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { computeTargetCapabilitiesService } from "@/app/compute-targets/capabilities-service";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  dispatchOrchestratorTurn,
  dispatchOrchestratorTurnCancel,
} from "@/lib/loops/loop-desktop";
import { renderCase } from "./case-render";
import { readChannel } from "./channel";
import { newerMessageWaiting, supersedeRequested } from "./supersede";
import { advanceTasks } from "./tasks";
import { buildTurnPrompt } from "./turn-prompt";
import { readTurnTimeoutMs } from "./turn-usage";
import { evaluateWaits, fireDueDeadlines } from "./waits";
import { loadOrchestratorWorkflows } from "./workflow-settings";

/**
 * The orchestrator's conversations move here (docs/orchestrator.md): one
 * turn at a time per conversation (a lease, like advanceRun's), conversations
 * in parallel. A turn starts when the conversation has messages no turn took
 * and its thread is quiet (`nextWakeAt`); it runs on the orchestrator's runner
 * as a desktop command and is settled from the command's result. The turn's
 * tools set how it ended; a turn that set nothing waits for people.
 */

const LEASE_MS = 2 * 60_000;
const TICK_LIMIT = 50;
const MESSAGES_PER_TURN = 50;
/** A failed turn's messages are taken again, at most this many times in a row. */
const FAILED_TURNS_MAX = 3;
const RETRY_DELAY_MS = 2 * 60_000;
/** Disabled orchestrator or no runner: look again later. */
const PAUSED_DELAY_MS = 5 * 60_000;
/** How long past its time limit a turn's command may still answer. */
const TURN_ANSWER_GRACE_MS = 5 * 60_000;
const ERROR_MAX = 2000;
const LOG_PREFIX = "[orchestrator/advance]";

const FAILED_COMMAND_STATUSES: ReadonlySet<string> = new Set<string>([
  DesktopCommandStatus.Failed,
  DesktopCommandStatus.Cancelled,
  DesktopCommandStatus.Expired,
]);

/**
 * The tick's stage: queued tasks try their runner, finished tasks settle and
 * their conversations' waits are evaluated, deadlines fire, then the
 * conversations whose turn is due or running move.
 */
export async function advanceDueConversations(
  now: Date = new Date()
): Promise<{ advanced: number; tasksLaunched: number; waitsFired: number }> {
  const tasks = await advanceTasks(now);
  let waitsFired = await fireDueDeadlines(now);
  for (const conversationId of tasks.settledConversationIds) {
    if (await evaluateWaits(conversationId, now)) {
      waitsFired += 1;
    }
  }
  const [due, running] = await Promise.all([
    withDb((db) =>
      db.orchestratorConversation.findMany({
        where: { nextWakeAt: { lte: now } },
        orderBy: { nextWakeAt: "asc" },
        take: TICK_LIMIT,
        select: { id: true },
      })
    ),
    withDb((db) =>
      db.orchestratorTurn.findMany({
        where: { status: OrchestratorTurnStatus.Running },
        take: TICK_LIMIT,
        select: { conversationId: true },
      })
    ),
  ]);
  const ids = [
    ...new Set([
      ...due.map((row) => row.id),
      ...running.map((row) => row.conversationId),
    ]),
  ];
  await mapWithDbConcurrency(ids, (id) => advanceConversation(id, now));
  return { advanced: ids.length, tasksLaunched: tasks.launched, waitsFired };
}

export async function advanceConversation(
  conversationId: string,
  now: Date = new Date()
): Promise<void> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const leased = await withDb((db) =>
    db.orchestratorConversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil },
    })
  );
  if (leased.count !== 1) {
    return;
  }
  try {
    await step(conversationId, now);
  } catch (error) {
    log.error(`${LOG_PREFIX} advancing the conversation failed`, {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await withDb((db) =>
      db.orchestratorConversation.updateMany({
        where: { id: conversationId, leaseUntil },
        data: { leaseUntil: null },
      })
    );
  }
}

async function step(conversationId: string, now: Date): Promise<void> {
  const running = await withDb((db) =>
    db.orchestratorTurn.findFirst({
      where: { conversationId, status: OrchestratorTurnStatus.Running },
      orderBy: { startedAt: "desc" },
    })
  );
  if (running) {
    const settled = await settleTurn(running, now);
    if (!settled) {
      await supersedeIfAsked(running, now);
      return;
    }
  }
  await startTurnIfDue(conversationId, now);
}

/**
 * Concurrency `supersede`: a newer message (once its thread is quiet) stops
 * the running turn; the next turn takes the stopped turn's messages and the
 * new ones. Asked once per turn; the turn settles as superseded when its
 * command answers that it was stopped (a turn that finished first settles as
 * usual, and the next turn takes the newer message).
 */
async function supersedeIfAsked(turn: TurnRow, now: Date): Promise<void> {
  if (
    supersedeRequested(turn.usage) ||
    readCancelRequest(turn) ||
    !turn.computeTargetId
  ) {
    return;
  }
  const conversation = await withDb((db) =>
    db.orchestratorConversation.findUnique({
      where: { id: turn.conversationId },
      select: {
        organizationId: true,
        nextWakeAt: true,
        case: { select: { workflowId: true } },
      },
    })
  );
  if (
    !conversation ||
    (conversation.nextWakeAt && conversation.nextWakeAt > now)
  ) {
    return;
  }
  const workflowId = conversation.case.workflowId;
  const [workflows, newer] = await Promise.all([
    loadOrchestratorWorkflows(conversation.organizationId, [workflowId]),
    newerMessageWaiting(turn.conversationId),
  ]);
  const concurrency = workflows.get(workflowId)?.concurrency;
  if (concurrency !== OrchestratorConcurrency.Supersede || !newer) {
    return;
  }
  await withDb((db) =>
    db.orchestratorTurn.update({
      where: { id: turn.id },
      data: {
        usage: {
          timeoutMs: readTurnTimeoutMs(turn.usage),
          supersedeRequestedAt: now.toISOString(),
        },
      },
    })
  );
  try {
    await dispatchOrchestratorTurnCancel({
      computeTargetId: turn.computeTargetId,
      turnId: turn.id,
    });
  } catch (error) {
    // The turn then finishes as usual; the newer message waits for the next.
    log.warn(`${LOG_PREFIX} the turn could not be stopped`, {
      turnId: turn.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** An admin asked to stop the turn (`cancelTurn`): the turn is not retried. */
const cancelRequestSchema = z.object({
  cancelRequestedAt: z.string(),
  cancelledBy: z.string(),
});

function readCancelRequest(turn: TurnRow): { cancelledBy: string } | null {
  const parsed = cancelRequestSchema.safeParse(turn.usage);
  return parsed.success ? { cancelledBy: parsed.data.cancelledBy } : null;
}

/** A stopped turn gives its messages to the next turn, at once. */
async function settleSuperseded(
  turn: TurnRow,
  sessionId: string | null,
  now: Date
): Promise<void> {
  await finishTurn(turn, {
    status: OrchestratorTurnStatus.Superseded,
    sessionId,
    summary: null,
    error: ORCHESTRATOR_TURN_STOPPED_ERROR,
    usage: null,
    now,
  });
  await withDb.tx(async (tx) => {
    await tx.orchestratorMessage.updateMany({
      where: {
        turnId: turn.id,
        kind: {
          notIn: [
            OrchestratorMessageKind.Reply,
            OrchestratorMessageKind.ToolRefused,
          ],
        },
      },
      data: { turnId: null },
    });
    await tx.orchestratorConversation.update({
      where: { id: turn.conversationId },
      data: { nextWakeAt: now },
    });
  });
}

type TurnRow = Prisma.OrchestratorTurnGetPayload<object>;

/** Settles a finished turn; false while it still runs. */
async function settleTurn(turn: TurnRow, now: Date): Promise<boolean> {
  const progress = await readTurnProgress(turn, now);
  if (progress === null) {
    return false;
  }
  if (progress.ok) {
    await finishTurn(turn, {
      status: OrchestratorTurnStatus.Succeeded,
      sessionId: progress.sessionId,
      summary: progress.answer,
      error: null,
      usage: {
        costUsd: progress.costUsd,
        inputTokens: progress.inputTokens,
        outputTokens: progress.outputTokens,
      },
      now,
    });
    return true;
  }
  const cancel = readCancelRequest(turn);
  if (cancel) {
    await finishTurn(turn, {
      status: OrchestratorTurnStatus.Failed,
      sessionId: progress.sessionId,
      summary: null,
      error: `Stopped by ${cancel.cancelledBy}.`,
      usage: null,
      now,
    });
    return true;
  }
  if (supersedeRequested(turn.usage)) {
    await settleSuperseded(turn, progress.sessionId, now);
    return true;
  }
  await failTurn(
    turn,
    progress.error,
    progress.retryable,
    progress.sessionId,
    now
  );
  return true;
}

/** The turn's result once its command finished, else null. */
async function readTurnProgress(
  turn: TurnRow,
  now: Date
): Promise<OrchestratorTurnResult | null> {
  const command = turn.commandId
    ? await desktopCommandStore.getCommandById(turn.commandId)
    : null;
  if (!command) {
    // A turn whose dispatch never recorded its command (the API stopped
    // in between) is given up after the lease.
    return now.getTime() - turn.startedAt.getTime() > LEASE_MS
      ? turnFailure(
          "The turn's command on the orchestrator's runner no longer exists."
        )
      : null;
  }
  if (command.status === DesktopCommandStatus.Done) {
    return await readCommandResult(command);
  }
  if (FAILED_COMMAND_STATUSES.has(command.status)) {
    return turnFailure(
      `The orchestrator's runner did not run the turn (${command.status}${command.error ? `: ${command.error}` : ""}).`
    );
  }
  const limit =
    turn.startedAt.getTime() +
    readTurnTimeoutMs(turn.usage) +
    TURN_ANSWER_GRACE_MS;
  if (now.getTime() <= limit) {
    return null;
  }
  await desktopCommandStore.markCommandExpired(
    command.commandId,
    "orchestrator_turn_wait_exceeded",
    { commandId: command.commandId, computeTargetId: command.computeTargetId }
  );
  return turnFailure(
    "The orchestrator's runner did not finish the turn in time."
  );
}

async function readCommandResult(command: {
  commandId: string;
  computeTargetId: string;
}): Promise<OrchestratorTurnResult> {
  const events =
    (await desktopCommandStore.getCommandEvents(
      command.computeTargetId,
      command.commandId
    )) ?? [];
  for (const event of [...events].reverse()) {
    if (event.eventType !== "result") {
      continue;
    }
    const parsed = orchestratorTurnResultSchema.safeParse(event.data);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return turnFailure(
    "The orchestrator's runner finished the turn without an answer."
  );
}

async function finishTurn(
  turn: TurnRow,
  outcome: {
    status: OrchestratorTurnStatus;
    sessionId: string | null;
    summary: string | null;
    error: string | null;
    usage: Prisma.InputJsonValue | null;
    now: Date;
  }
): Promise<void> {
  const ended = turn.ended ?? OrchestratorTurnEnd.WaitHuman;
  await withDb.tx(async (tx) => {
    const updated = await tx.orchestratorTurn.updateMany({
      where: { id: turn.id, status: OrchestratorTurnStatus.Running },
      data: {
        status: outcome.status,
        ended,
        sessionId: outcome.sessionId,
        summary: outcome.summary,
        error: outcome.error,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        finishedAt: outcome.now,
        tokenHash: null,
      },
    });
    if (updated.count !== 1) {
      return;
    }
    await tx.orchestratorConversation.update({
      where: { id: turn.conversationId },
      data: {
        status:
          ended === OrchestratorTurnEnd.Close
            ? OrchestratorConversationStatus.Closed
            : OrchestratorConversationStatus.Waiting,
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      },
    });
  });
}

async function failTurn(
  turn: TurnRow,
  error: string,
  retryable: boolean,
  sessionId: string | null,
  now: Date
): Promise<void> {
  log.warn(`${LOG_PREFIX} turn failed`, {
    turnId: turn.id,
    conversationId: turn.conversationId,
    error,
  });
  const recent = await withDb((db) =>
    db.orchestratorTurn.findMany({
      where: { conversationId: turn.conversationId, id: { not: turn.id } },
      orderBy: { startedAt: "desc" },
      take: FAILED_TURNS_MAX - 1,
      select: { status: true },
    })
  );
  let failedInRow = 1;
  for (const row of recent) {
    if (row.status !== OrchestratorTurnStatus.Failed) {
      break;
    }
    failedInRow += 1;
  }
  const retry = retryable && failedInRow < FAILED_TURNS_MAX;
  await finishTurn(turn, {
    status: OrchestratorTurnStatus.Failed,
    sessionId,
    summary: null,
    error: error.slice(0, ERROR_MAX),
    usage: null,
    now,
  });
  if (!retry) {
    return;
  }
  // The messages wait for the next turn, a while later.
  await withDb.tx(async (tx) => {
    await tx.orchestratorMessage.updateMany({
      where: {
        turnId: turn.id,
        kind: { not: OrchestratorMessageKind.ToolRefused },
      },
      data: { turnId: null },
    });
    await tx.orchestratorConversation.update({
      where: { id: turn.conversationId },
      data: { nextWakeAt: new Date(now.getTime() + RETRY_DELAY_MS) },
    });
  });
}

async function startTurnIfDue(
  conversationId: string,
  now: Date
): Promise<void> {
  const conversation = await withDb((db) =>
    db.orchestratorConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        caseId: true,
        case: {
          select: { workflowId: true, project: { select: { name: true } } },
        },
        channel: true,
        sessionId: true,
        nextWakeAt: true,
        _count: { select: { turns: true } },
      },
    })
  );
  if (!conversation) {
    return;
  }
  if (conversation.nextWakeAt && conversation.nextWakeAt > now) {
    return;
  }
  const messages = await withDb((db) =>
    db.orchestratorMessage.findMany({
      where: { conversationId, turnId: null },
      orderBy: { createdAt: "asc" },
      take: MESSAGES_PER_TURN,
      select: {
        id: true,
        origin: true,
        kind: true,
        actor: true,
        text: true,
        payload: true,
        externalRef: true,
        createdAt: true,
      },
    })
  );
  if (messages.length === 0) {
    await withDb((db) =>
      db.orchestratorConversation.update({
        where: { id: conversationId },
        data: { nextWakeAt: null },
      })
    );
    return;
  }
  const workflowId = conversation.case.workflowId;
  const settings = (
    await loadOrchestratorWorkflows(conversation.organizationId, [workflowId])
  ).get(workflowId);
  if (!(settings?.enabled && settings.computeTargetId)) {
    await withDb((db) =>
      db.orchestratorConversation.update({
        where: { id: conversationId },
        data: { nextWakeAt: new Date(now.getTime() + PAUSED_DELAY_MS) },
      })
    );
    return;
  }
  const timeoutMs = settings.turnTimeoutMinutes * 60_000;
  const turn = await withDb.tx(async (tx) => {
    const created = await tx.orchestratorTurn.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId,
        status: OrchestratorTurnStatus.Running,
        computeTargetId: settings.computeTargetId,
        startedAt: now,
        usage: { timeoutMs },
      },
      select: { id: true },
    });
    await tx.orchestratorMessage.updateMany({
      where: { id: { in: messages.map((message) => message.id) } },
      data: { turnId: created.id },
    });
    await tx.orchestratorConversation.update({
      where: { id: conversationId },
      data: { status: OrchestratorConversationStatus.Turn, nextWakeAt: null },
    });
    return created;
  });
  const prompt = buildTurnPrompt({
    projectName: conversation.case.project.name,
    workflowName: settings.name,
    workflowDescription: settings.description,
    rules: settings.rules,
    channel: readChannel(conversation.channel),
    caseMarkdown: await renderCase(conversation.caseId),
    messages,
    runners: await computeTargetCapabilitiesService.listForProject(
      conversation.organizationId,
      conversation.projectId
    ),
    continuing: conversation._count.turns > 0 && !!conversation.sessionId,
    cancelOn: settings.cancelOn,
  });
  try {
    const commandId = await dispatchOrchestratorTurn({
      computeTargetId: settings.computeTargetId,
      request: {
        turnId: turn.id,
        projectId: conversation.projectId,
        sessionId: conversation.sessionId,
        prompt,
        timeoutMs,
      },
    });
    await withDb((db) =>
      db.orchestratorTurn.update({
        where: { id: turn.id },
        data: { commandId },
      })
    );
  } catch (error) {
    const row = await withDb((db) =>
      db.orchestratorTurn.findUnique({ where: { id: turn.id } })
    );
    if (row) {
      await failTurn(
        row,
        `The turn could not be sent to the orchestrator's runner: ${error instanceof Error ? error.message : String(error)}`,
        true,
        null,
        now
      );
    }
  }
}

function turnFailure(error: string): OrchestratorTurnResult {
  return { type: "result", ok: false, error, retryable: true, sessionId: null };
}
