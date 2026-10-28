import {
  type WorkflowActionRunStatus as ActionRunStatusValue,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowInstructionRunDetail,
  WorkflowRunEvent,
  WorkflowRunStatus,
  workflowInstructionConfigSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WORKFLOW_EMAIL_ACTION_TYPE } from "@repo/api/src/types/workflow-email";
import type { WorkflowInstructionResult } from "@repo/api/src/types/workflow-instruction";
import { Prisma, type WorkflowActionRun, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  createProviderContext,
  type LoadedConnection,
} from "@/lib/integrations/connection-service";
import { findActionDefinition } from "@/lib/integrations/registry";
import type {
  ActionResult,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import { waitUntil } from "@/lib/wait-until";
import { renderTemplate } from "../template";
import {
  type ActionConnectionResult,
  resolveActionConnection,
} from "./action-connection";
import { mergeActionResults } from "./action-results";
import {
  compareActionRunOrder,
  isFinalActionRunStatus,
  type OrderedActionRun,
} from "./action-run-order";
import { executeEmailAction } from "./email-action";
import { scrubProviderError, trimMessage } from "./errors";
import {
  readInstructionProgress,
  startInstruction,
  summarizeInstruction,
} from "./instruction-action";
import { toJsonObject } from "./run-data";
import { recordActionOutputs } from "./run-repository";
import { buildRunSnapshot, snapshotTemplateVariables } from "./snapshot";

/**
 * Action runs (docs/workflows.md "Actions"). One workflow_action_runs row per
 * (run, action, event, cycle). Pre rows (stage pre, event workflow.triggered)
 * are executed inline by the run state machine (pre-actions.ts); post rows by
 * the outbox drain below, which never touches pre rows. The rows of one run
 * go strictly in order (action-run-order.ts): one that waits holds the rest. Both
 * use the same executor (advanceActionRun): a pending row is claimed
 * pending -> running, executed through the provider's action definition, and
 * settled final or back to pending with backoff. An instruction
 * (instruction-action.ts) settles `waiting` while its agent works on the
 * run's computer; once the agent answered, the row is claimed again
 * (waiting -> running) and its operations are carried out. Post actions never
 * change the run status.
 */

export const ACTION_MAX_ATTEMPTS = 5;
/** Delay before attempt n+1 after a retryable failure of attempt n. */
export const ACTION_RETRY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;
/** A row left in running this long belongs to a process that died. */
export const ACTION_RUNNING_STALE_MS = 10 * 60_000;
export const ACTION_DRAIN_DEFAULT_LIMIT = 50;
/** Why the post rows of a cancelled run do not run. */
export const RUN_CANCELLED_SKIP_REASON = "The run was cancelled.";
/** Runs drained in parallel; rows of one run are executed in order. */
const ACTION_DRAIN_RUN_CONCURRENCY = 4;
const LOG_PREFIX = "[workflows/actions]";
const EXTERNAL_REF_MAX_LENGTH = 2000;

export type RunEventTarget = {
  id: string;
  organizationId: string;
  workflowId: string;
  cycle: number;
};

export type ActionDrainCounts = {
  claimed: number;
  succeeded: number;
  skipped: number;
  retried: number;
  failed: number;
};

/** How one attempt of an action run ended. */
export type ActionRunSettlement = {
  /** succeeded / skipped / failed are final; pending waits for nextAttemptAt. */
  status: ActionRunStatusValue;
  lastError: string | null;
  nextAttemptAt: Date | null;
};

/**
 * Inserts one pending action run per enabled action of the workflow that runs
 * on the events: workflow.triggered enqueues the pre actions, every other
 * event the post actions subscribed to it, in the workflow's action order
 * (then event order for an action on several of them). Idempotent per (run,
 * action, event, cycle). Call it inside the transaction that writes the
 * matching run status, then drain (post rows) or keep advancing the run (pre
 * rows). `now` is the transition time: the rows are due at it, so the advance
 * that wrote the status (and compares against that same time) executes the
 * pre rows inline.
 */
export async function enqueueRunEvents(
  run: RunEventTarget,
  events: readonly WorkflowRunEvent[],
  now: Date = new Date()
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }
  const actions = await loadActionsForEvents(run, events);
  const rows = actions.flatMap((action) =>
    events
      .filter((event) => runsOnEvent(action, event))
      .map((event) => ({
        organizationId: run.organizationId,
        runId: run.id,
        actionId: action.id,
        actionType: action.type,
        stage: stageOfEvent(event),
        event,
        cycle: run.cycle,
        status: WorkflowActionRunStatus.Pending,
        nextAttemptAt: now,
      }))
  );
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await withDb((db) =>
    db.workflowActionRun.createMany({ data: rows, skipDuplicates: true })
  );
  return inserted.count;
}

/** Enqueues a single event and drains the run's outbox in the background. */
export async function enqueueRunEvent(
  run: RunEventTarget,
  event: WorkflowRunEvent
): Promise<void> {
  const inserted = await enqueueRunEvents(run, [event]);
  if (inserted > 0 && hasPostEvents([event])) {
    waitUntil(drainActionRuns({ runId: run.id }));
  }
}

/** True when the workflow has at least one enabled pre action. */
export async function hasEnabledPreActions(
  run: Pick<RunEventTarget, "organizationId" | "workflowId">
): Promise<boolean> {
  const action = await withDb((db) =>
    db.workflowAction.findFirst({
      where: {
        workflowId: run.workflowId,
        organizationId: run.organizationId,
        enabled: true,
        stage: WorkflowActionStage.Pre,
      },
      select: { id: true },
    })
  );
  return action !== null;
}

/** True when any of the events is executed by the outbox drain (post stage). */
export function hasPostEvents(events: readonly WorkflowRunEvent[]): boolean {
  return events.some(
    (event) => stageOfEvent(event) === WorkflowActionStage.Post
  );
}

/**
 * Advances the post action runs of the runs that have a due or waiting one
 * (optionally of one run only; at most `limit` runs). Pre rows are executed
 * by the run state machine, never here. A run's open rows go in order
 * (action-run-order.ts) and the first one that cannot finish now (waiting for its
 * backoff or its agent, or another drain has it) holds the rest of that run
 * for the next drain, so overlapping drains never run one run's rows side by
 * side and a later action sees what the earlier ones did.
 */
export async function drainActionRuns(
  options: { runId?: string; limit?: number; now?: Date } = {}
): Promise<ActionDrainCounts> {
  const now = options.now ?? new Date();
  const runs = await withDb((db) =>
    db.workflowActionRun.groupBy({
      by: ["runId"],
      where: {
        stage: WorkflowActionStage.Post,
        ...(options.runId ? { runId: options.runId } : {}),
        OR: [
          {
            status: WorkflowActionRunStatus.Pending,
            nextAttemptAt: { lte: now },
          },
          { status: WorkflowActionRunStatus.Waiting },
        ],
      },
      _min: { nextAttemptAt: true },
      orderBy: { _min: { nextAttemptAt: "asc" } },
      take: options.limit ?? ACTION_DRAIN_DEFAULT_LIMIT,
    })
  );
  const counts: ActionDrainCounts = {
    claimed: 0,
    succeeded: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
  };
  await mapWithDbConcurrency(
    runs,
    async ({ runId }) => {
      const rows = await listOpenActionRuns(runId, WorkflowActionStage.Post);
      for (const row of rows) {
        const settlement = await advanceActionRun(row, now);
        tally(counts, toDrainOutcome(settlement));
        if (!(settlement && isFinalActionRunStatus(settlement.status))) {
          return;
        }
      }
    },
    pLimit(ACTION_DRAIN_RUN_CONCURRENCY)
  );
  return counts;
}

/**
 * Moves one row on if it can go now: a due pending row is executed, a
 * waiting row finishes once its agent answered. Returns how the attempt
 * ended, or null when the row waits (backoff, agent at work, another worker
 * has it), which holds the run's later rows.
 */
export async function advanceActionRun(
  row: WorkflowActionRun,
  now: Date
): Promise<ActionRunSettlement | null> {
  if (row.status === WorkflowActionRunStatus.Waiting) {
    return await resumeWaitingActionRun(row, now);
  }
  if (
    row.status === WorkflowActionRunStatus.Pending &&
    row.nextAttemptAt.getTime() <= now.getTime()
  ) {
    return await runActionRun(row, now);
  }
  return null;
}

/**
 * Rows stuck in running (the process died mid-action) go back to pending, or
 * to failed when they already used every attempt. The tick requeues post
 * rows; the pre_actions step requeues the pre rows of its own run. Waiting
 * rows are not stuck: their agent bounds itself (instruction-action.ts).
 */
export async function requeueStaleActionRuns(
  now: Date = new Date(),
  scope: { runId?: string; stage?: WorkflowActionStage } = {}
): Promise<number> {
  const staleBefore = new Date(now.getTime() - ACTION_RUNNING_STALE_MS);
  const stale: Prisma.WorkflowActionRunWhereInput = {
    stage: scope.stage ?? WorkflowActionStage.Post,
    ...(scope.runId ? { runId: scope.runId } : {}),
    status: WorkflowActionRunStatus.Running,
    updatedAt: { lt: staleBefore },
  };
  const [exhausted, requeued] = await Promise.all([
    withDb((db) =>
      db.workflowActionRun.updateMany({
        where: { ...stale, attempts: { gte: ACTION_MAX_ATTEMPTS } },
        data: {
          status: WorkflowActionRunStatus.Failed,
          completedAt: now,
          lastError: "The action was interrupted and has no attempts left.",
        },
      })
    ),
    withDb((db) =>
      db.workflowActionRun.updateMany({
        where: { ...stale, attempts: { lt: ACTION_MAX_ATTEMPTS } },
        data: { status: WorkflowActionRunStatus.Pending, nextAttemptAt: now },
      })
    ),
  ]);
  return exhausted.count + requeued.count;
}

/** Retry delay after `attempts` attempts, or null when no attempt is left. */
export function retryDelayMs(attempts: number): number | null {
  if (attempts >= ACTION_MAX_ATTEMPTS) {
    return null;
  }
  const index = Math.min(
    Math.max(attempts, 1) - 1,
    ACTION_RETRY_BACKOFF_MS.length - 1
  );
  return ACTION_RETRY_BACKOFF_MS[index];
}

/**
 * The executor shared by the outbox drain (post rows) and the pre_actions
 * step (pre rows): claims one row that is pending and due at `now` (pending
 * -> running, attempts + 1), executes it and settles it. The attempt number
 * comes from the claimed row, never from the caller's earlier read. Returns
 * how the attempt ended (a final status, or pending again with its next
 * attempt time), or null when the row was not claimable (another worker has
 * it, or it was rescheduled to a later attempt since it was read).
 */
export async function runActionRun(
  row: WorkflowActionRun,
  now: Date
): Promise<ActionRunSettlement | null> {
  const [claimed] = await withDb((db) =>
    db.workflowActionRun.updateManyAndReturn({
      where: {
        id: row.id,
        stage: row.stage,
        status: WorkflowActionRunStatus.Pending,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: WorkflowActionRunStatus.Running,
        attempts: { increment: 1 },
      },
      select: { attempts: true },
    })
  );
  if (!claimed) {
    return null;
  }
  return await executeClaimedActionRun(row, claimed.attempts);
}

/**
 * Finishes a waiting instruction row once its agent answered: claims it
 * waiting -> running (the attempt was counted when it started) and settles
 * it from the integration tool calls the agent made. Null while the agent works, or when
 * another worker claimed the row.
 */
export async function resumeWaitingActionRun(
  row: WorkflowActionRun,
  now: Date
): Promise<ActionRunSettlement | null> {
  const progress = await readInstructionProgress(row, now);
  if (progress.kind === "running") {
    return null;
  }
  const [claimed] = await withDb((db) =>
    db.workflowActionRun.updateManyAndReturn({
      where: {
        id: row.id,
        status: WorkflowActionRunStatus.Waiting,
        commandId: row.commandId,
      },
      data: { status: WorkflowActionRunStatus.Running },
      select: { attempts: true },
    })
  );
  if (!claimed) {
    return null;
  }
  let execution: ExecutionResult;
  try {
    execution = await finishInstruction(row, claimed.attempts, progress.result);
  } catch (error) {
    log.error(`${LOG_PREFIX} Instruction failed unexpectedly`, {
      actionRunId: row.id,
      runId: row.runId,
      error,
    });
    execution = unexpectedFailure();
  }
  return await settleActionRun(row, claimed.attempts, execution);
}

/**
 * Marks the unfinished pre rows of one run cycle skipped because the run
 * stopped before they could run. Returns the number of rows changed.
 */
export async function skipUnfinishedPreActionRuns(
  run: { id: string; cycle: number },
  reason: string
): Promise<number> {
  const skipped = await withDb((db) =>
    db.workflowActionRun.updateMany({
      where: {
        runId: run.id,
        cycle: run.cycle,
        stage: WorkflowActionStage.Pre,
        status: {
          in: [
            WorkflowActionRunStatus.Pending,
            WorkflowActionRunStatus.Running,
            WorkflowActionRunStatus.Waiting,
          ],
        },
      },
      data: {
        status: WorkflowActionRunStatus.Skipped,
        completedAt: new Date(),
        lastError: trimMessage(reason),
      },
    })
  );
  return skipped.count;
}

/** Drain outcomes besides the final action run statuses. */
const DrainOutcome = {
  Unclaimed: "unclaimed",
  Retried: "retried",
} as const;
type DrainOutcome = (typeof DrainOutcome)[keyof typeof DrainOutcome];

type ActionOutcome = DrainOutcome | ActionRunStatusValue;

type ExecutionResult =
  | {
      kind: "result";
      result: ActionResult;
      secrets: Record<string, unknown>;
      /** Instructions: what the agent did. */
      detail?: WorkflowInstructionRunDetail;
    }
  | { kind: "skip"; reason: string }
  /** An instruction's agent was started on the run's computer. */
  | { kind: "wait"; commandId: string };

type ActionCandidate = {
  id: string;
  type: string;
  stage: string;
  events: string[];
};

/**
 * What an action run works with once its connections are chosen: one, or
 * for a repository-scoped action without its own connection every
 * connection that owns one of the run's repositories; none for an email.
 */
type ActionRunContext = {
  kind: "context";
  action: { type: string; config: unknown };
  connections: LoadedConnection[];
  snapshot: WorkflowRunSnapshot;
};

/** Executes a row this worker claimed; `attempt` is the 1-based attempt number. */
async function executeClaimedActionRun(
  row: WorkflowActionRun,
  attempt: number
): Promise<ActionRunSettlement> {
  let execution: ExecutionResult;
  try {
    execution = await executeActionRun(row, attempt);
  } catch (error) {
    log.error(`${LOG_PREFIX} Action run failed unexpectedly`, {
      actionRunId: row.id,
      runId: row.runId,
      actionType: row.actionType,
      error,
    });
    execution = unexpectedFailure();
  }
  return await settleActionRun(row, attempt, execution);
}

async function executeActionRun(
  row: WorkflowActionRun,
  attempt: number
): Promise<ExecutionResult> {
  const context = await loadActionRunContext(row);
  if (context.kind === "skip") {
    return context;
  }
  const { action, connections, snapshot } = context;
  const render = (template: string) =>
    renderTemplate(template, snapshotTemplateVariables(snapshot));
  if (action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return await startInstructionRun(row, attempt, context, render);
  }
  if (action.type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return {
      kind: "result",
      result: await executeEmailAction({
        config: action.config,
        snapshot,
        render,
        actionRunId: row.id,
      }),
      secrets: {},
    };
  }
  const [primary] = connections;
  if (!primary) {
    return { kind: "skip", reason: "No usable connection." };
  }
  const definition = findActionDefinition(primary.provider.key, action.type);
  if (!definition) {
    return {
      kind: "skip",
      reason: `The action type "${action.type}" is no longer provided by ${primary.provider.displayName}.`,
    };
  }
  const config = definition.configSchema.safeParse(action.config);
  if (!config.success) {
    return {
      kind: "skip",
      reason: "The action configuration is no longer valid. Edit the workflow.",
    };
  }
  // One connection at a time: an action runs on a handful at most.
  const results: ActionResult[] = [];
  for (const connection of connections) {
    results.push(
      await definition.execute({
        ...createProviderContext(connection.runtime, LOG_PREFIX),
        config: config.data,
        run: snapshot,
        actionRunId: row.id,
        attempt,
        render,
      })
    );
  }
  return {
    kind: "result",
    result: mergeActionResults(results),
    secrets: connectionSecrets(connections),
  };
}

/** The row's action, the connection it works through and the run snapshot. */
async function loadActionRunContext(
  row: WorkflowActionRun
): Promise<ActionRunContext | { kind: "skip"; reason: string }> {
  const event = workflowRunEventSchema.safeParse(row.event);
  if (!event.success) {
    return { kind: "skip", reason: `Unknown run event "${row.event}"` };
  }
  const actionId = row.actionId;
  const action = actionId
    ? await withDb((db) =>
        db.workflowAction.findFirst({
          where: { id: actionId, organizationId: row.organizationId },
          select: {
            connectionId: true,
            connectionKey: true,
            type: true,
            config: true,
          },
        })
      )
    : null;
  if (!action) {
    return {
      kind: "skip",
      reason: "The action was removed from the workflow.",
    };
  }
  const resolved = await resolveRowConnections(row, action);
  if (!resolved.ok) {
    return { kind: "skip", reason: resolved.reason };
  }
  const snapshot = await buildRunSnapshot(row.runId, event.data);
  if (!snapshot) {
    return { kind: "skip", reason: "The run no longer exists." };
  }
  if (snapshot.status === WorkflowRunStatus.Cancelled) {
    return { kind: "skip", reason: RUN_CANCELLED_SKIP_REASON };
  }
  return {
    kind: "context",
    action,
    connections: resolved.connections,
    snapshot,
  };
}

async function startInstructionRun(
  row: WorkflowActionRun,
  attempt: number,
  context: ActionRunContext,
  render: (template: string) => string
): Promise<ExecutionResult> {
  const config = workflowInstructionConfigSchema.safeParse(
    context.action.config
  );
  if (!config.success) {
    return {
      kind: "skip",
      reason: "The instruction is no longer valid. Edit the workflow.",
    };
  }
  const started = await startInstruction({
    actionRunId: row.id,
    attempt,
    organizationId: row.organizationId,
    runId: row.runId,
    instruction: render(config.data.instruction),
    grants: config.data.connections,
    snapshot: context.snapshot,
  });
  switch (started.kind) {
    case "dispatched":
      return { kind: "wait", commandId: started.commandId };
    case "skip":
      return started;
    default:
      return {
        kind: "result",
        result: {
          status: WorkflowActionRunStatus.Failed,
          error: started.error,
          retryable: started.retryable,
        },
        secrets: {},
      };
  }
}

/** Settles an instruction from its agent's answer and tool calls. */
async function finishInstruction(
  row: WorkflowActionRun,
  attempt: number,
  answer: WorkflowInstructionResult
): Promise<ExecutionResult> {
  if (!answer.ok) {
    return {
      kind: "result",
      result: {
        status: WorkflowActionRunStatus.Failed,
        error: answer.error,
        retryable: answer.retryable,
      },
      secrets: {},
    };
  }
  const outcome = await summarizeInstruction({
    actionRunId: row.id,
    attempt,
    answer,
  });
  return {
    kind: "result",
    result: outcome.result,
    secrets: {},
    detail: outcome.detail,
  };
}

async function settleActionRun(
  row: WorkflowActionRun,
  attempts: number,
  execution: ExecutionResult
): Promise<ActionRunSettlement> {
  const now = new Date();
  const data = buildSettlement(attempts, execution, now);
  // Before the settlement, so the run's next action already sees the outputs.
  // A failed result reports them too (e.g. the pull requests opened before
  // one repository failed).
  if (
    execution.kind === "result" &&
    execution.result.status !== WorkflowActionRunStatus.Skipped
  ) {
    await recordActionOutputs(row.runId, execution.result.outputs);
  }
  await withDb((db) =>
    db.workflowActionRun.updateMany({
      where: { id: row.id, status: WorkflowActionRunStatus.Running },
      data,
    })
  );
  return {
    status: data.status,
    lastError: data.lastError ?? null,
    nextAttemptAt: data.nextAttemptAt ?? null,
  };
}

function buildSettlement(
  attempts: number,
  execution: ExecutionResult,
  now: Date
): {
  status: ActionRunStatusValue;
  completedAt?: Date | null;
  nextAttemptAt?: Date;
  lastError?: string | null;
  externalRef?: string | null;
  commandId?: string;
  detail?: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  if (execution.kind === "wait") {
    return {
      status: WorkflowActionRunStatus.Waiting,
      commandId: execution.commandId,
      lastError: null,
      detail: Prisma.DbNull,
    };
  }
  const detail = execution.kind === "result" ? execution.detail : undefined;
  return {
    ...buildFinalSettlement(attempts, execution, now),
    ...(detail ? { detail: toJsonObject(detail) } : {}),
  };
}

function buildFinalSettlement(
  attempts: number,
  execution: Exclude<ExecutionResult, { kind: "wait" }>,
  now: Date
): ReturnType<typeof buildSettlement> {
  if (execution.kind === "skip") {
    return {
      status: WorkflowActionRunStatus.Skipped,
      completedAt: now,
      lastError: trimMessage(execution.reason),
    };
  }
  const { result, secrets } = execution;
  if (result.status === WorkflowActionRunStatus.Succeeded) {
    return {
      status: WorkflowActionRunStatus.Succeeded,
      completedAt: now,
      lastError: null,
      externalRef:
        result.externalRef?.slice(0, EXTERNAL_REF_MAX_LENGTH) ?? null,
    };
  }
  if (result.status === WorkflowActionRunStatus.Skipped) {
    return {
      status: WorkflowActionRunStatus.Skipped,
      completedAt: now,
      lastError: trimMessage(result.reason),
    };
  }
  const lastError = scrubProviderError(result.error, secrets);
  const delay = result.retryable ? retryDelayMs(attempts) : null;
  if (delay !== null) {
    return {
      status: WorkflowActionRunStatus.Pending,
      nextAttemptAt: new Date(now.getTime() + delay),
      lastError,
    };
  }
  return {
    status: WorkflowActionRunStatus.Failed,
    completedAt: now,
    lastError,
  };
}

/** workflow.triggered selects the pre actions, the other events post actions. */
async function loadActionsForEvents(
  run: RunEventTarget,
  events: readonly WorkflowRunEvent[]
): Promise<ActionCandidate[]> {
  const postEvents = events.filter(
    (event) => stageOfEvent(event) === WorkflowActionStage.Post
  );
  const stageFilters: Prisma.WorkflowActionWhereInput[] = [];
  if (postEvents.length < events.length) {
    stageFilters.push({ stage: WorkflowActionStage.Pre });
  }
  if (postEvents.length > 0) {
    stageFilters.push({
      stage: WorkflowActionStage.Post,
      events: { hasSome: postEvents },
    });
  }
  return await withDb((db) =>
    db.workflowAction.findMany({
      where: {
        workflowId: run.workflowId,
        organizationId: run.organizationId,
        enabled: true,
        OR: stageFilters,
      },
      select: { id: true, type: true, stage: true, events: true },
      orderBy: { position: "asc" },
    })
  );
}

function runsOnEvent(action: ActionCandidate, event: WorkflowRunEvent) {
  const stage = stageOfEvent(event);
  if (action.stage !== stage) {
    return false;
  }
  return stage === WorkflowActionStage.Pre || action.events.includes(event);
}

function stageOfEvent(event: WorkflowRunEvent): WorkflowActionStage {
  return event === WorkflowRunEvent.Triggered
    ? WorkflowActionStage.Pre
    : WorkflowActionStage.Post;
}

function toDrainOutcome(settlement: ActionRunSettlement | null): ActionOutcome {
  if (!settlement) {
    return DrainOutcome.Unclaimed;
  }
  if (settlement.status === WorkflowActionRunStatus.Pending) {
    return DrainOutcome.Retried;
  }
  return settlement.status;
}

function tally(counts: ActionDrainCounts, outcome: ActionOutcome): void {
  if (outcome === DrainOutcome.Unclaimed) {
    return;
  }
  // A waiting row (an instruction's agent started) counts as claimed only.
  counts.claimed += 1;
  if (outcome === DrainOutcome.Retried) {
    counts.retried += 1;
  } else if (outcome === WorkflowActionRunStatus.Succeeded) {
    counts.succeeded += 1;
  } else if (outcome === WorkflowActionRunStatus.Skipped) {
    counts.skipped += 1;
  } else if (outcome === WorkflowActionRunStatus.Failed) {
    counts.failed += 1;
  }
}

/** The run's rows that are not final yet, in the order they go. */
async function listOpenActionRuns(
  runId: string,
  stage: WorkflowActionStage
): Promise<(WorkflowActionRun & OrderedActionRun)[]> {
  const rows = await withDb((db) =>
    db.workflowActionRun.findMany({
      where: {
        runId,
        stage,
        status: {
          in: [
            WorkflowActionRunStatus.Pending,
            WorkflowActionRunStatus.Running,
            WorkflowActionRunStatus.Waiting,
          ],
        },
      },
      include: { action: { select: { position: true } } },
    })
  );
  return [...rows].sort(compareActionRunOrder);
}

function unexpectedFailure(): ExecutionResult {
  return {
    kind: "result",
    result: {
      status: WorkflowActionRunStatus.Failed,
      error: "Unexpected error while running the action",
      retryable: true,
    },
    secrets: {},
  };
}

/** Every connection's secrets, for scrubbing error text (keys kept apart). */
function connectionSecrets(
  connections: readonly LoadedConnection[]
): Record<string, unknown> {
  return Object.fromEntries(
    connections.flatMap((connection, index) =>
      Object.entries(connection.runtime.secrets).map(([key, value]) => [
        `${index}.${key}`,
        value,
      ])
    )
  );
}

/** The connections the row's action works through; an email needs none. */
async function resolveRowConnections(
  row: WorkflowActionRun,
  action: {
    connectionId: string | null;
    connectionKey: string | null;
    type: string;
  }
): Promise<
  { ok: true; connections: LoadedConnection[] } | ActionConnectionResult
> {
  if (action.type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return { ok: true, connections: [] };
  }
  return await resolveActionConnection({
    organizationId: row.organizationId,
    runId: row.runId,
    action,
  });
}

/**
 * Marks the run's post rows that have not started skipped because the run
 * was cancelled: a cancelled run no longer reports on its earlier events,
 * such as the questions of a step nobody will answer. Rows already running
 * or waiting for their agent finish. Returns the number of rows changed.
 */
export async function skipPendingPostActionRuns(
  runId: string,
  reason: string
): Promise<number> {
  const skipped = await withDb((db) =>
    db.workflowActionRun.updateMany({
      where: {
        runId,
        stage: WorkflowActionStage.Post,
        status: WorkflowActionRunStatus.Pending,
      },
      data: {
        status: WorkflowActionRunStatus.Skipped,
        completedAt: new Date(),
        lastError: trimMessage(reason),
      },
    })
  );
  return skipped.count;
}
