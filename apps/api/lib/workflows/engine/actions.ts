import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import {
  type WorkflowActionRunStatus as ActionRunStatusValue,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { type Prisma, type WorkflowActionRun, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  createProviderContext,
  type LoadedConnection,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import { findActionDefinition } from "@/lib/integrations/registry";
import type { ActionResult } from "@/lib/integrations/types";
import { waitUntil } from "@/lib/wait-until";
import { renderTemplate } from "../template";
import { scrubProviderError, trimMessage } from "./errors";
import { recordActionOutputs } from "./run-repository";
import { buildRunSnapshot, snapshotTemplateVariables } from "./snapshot";

/**
 * Action runs (docs/workflows.md "Actions"). One workflow_action_runs row per
 * (run, action, event, cycle). Pre rows (stage pre, event run.triggered) are
 * executed inline by the run state machine (pre-actions.ts), one at a time;
 * post rows by the outbox drain below, which never touches pre rows. Both use
 * the same executor (runActionRun): the row is claimed pending -> running,
 * executed through the provider's action definition, and settled final or
 * back to pending with backoff. Post actions never change the run status.
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
 * on the events: run.triggered enqueues the pre actions, every other event the
 * post actions subscribed to it. Idempotent per (run, action, event, cycle).
 * Call it inside the transaction that writes the matching run status, then
 * drain (post rows) or keep advancing the run (pre rows). `now` is the
 * transition time: the rows are due at it, so the advance that wrote the
 * status (and compares against that same time) executes the pre rows inline.
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
  const rows = events.flatMap((event) =>
    actions
      .filter((action) => runsOnEvent(action, event))
      .map((action) => ({
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
 * Claims and executes due post action runs (optionally of one run only). Pre
 * rows are executed by the run state machine, never here. Rows of one run
 * run in order; when one of them cannot be claimed (another drain has it, or
 * it was rescheduled since the read) the rest of that run waits for the next
 * drain, so overlapping drains never run one run's rows side by side.
 */
export async function drainActionRuns(
  options: { runId?: string; limit?: number; now?: Date } = {}
): Promise<ActionDrainCounts> {
  const now = options.now ?? new Date();
  const due = await withDb((db) =>
    db.workflowActionRun.findMany({
      where: {
        stage: WorkflowActionStage.Post,
        status: WorkflowActionRunStatus.Pending,
        nextAttemptAt: { lte: now },
        ...(options.runId ? { runId: options.runId } : {}),
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
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
  const byRun = groupByRun(due);
  await mapWithDbConcurrency(
    [...byRun.values()],
    async (rows) => {
      for (const row of rows) {
        const settlement = await runActionRun(row, now);
        tally(counts, toDrainOutcome(settlement));
        if (!settlement) {
          return;
        }
      }
    },
    pLimit(ACTION_DRAIN_RUN_CONCURRENCY)
  );
  return counts;
}

/**
 * Rows stuck in running (the process died mid-action) go back to pending, or
 * to failed when they already used every attempt. The tick requeues post
 * rows; the pre_actions step requeues the pre rows of its own run.
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
  | { kind: "result"; result: ActionResult; secrets: Record<string, unknown> }
  | { kind: "skip"; reason: string };

type ActionCandidate = {
  id: string;
  type: string;
  stage: string;
  events: string[];
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
    execution = {
      kind: "result",
      result: {
        status: WorkflowActionRunStatus.Failed,
        error: "Unexpected error while running the action",
        retryable: true,
      },
      secrets: {},
    };
  }
  return await settleActionRun(row, attempt, execution);
}

async function executeActionRun(
  row: WorkflowActionRun,
  attempt: number
): Promise<ExecutionResult> {
  const event = workflowRunEventSchema.safeParse(row.event);
  if (!event.success) {
    return { kind: "skip", reason: `Unknown run event "${row.event}"` };
  }
  const actionId = row.actionId;
  const action = actionId
    ? await withDb((db) =>
        db.workflowAction.findFirst({
          where: { id: actionId, organizationId: row.organizationId },
          select: { connectionId: true, type: true, config: true },
        })
      )
    : null;
  if (!action) {
    return {
      kind: "skip",
      reason: "The action was removed from the workflow.",
    };
  }
  const loaded = await loadConnectionRuntime(
    row.organizationId,
    action.connectionId
  );
  const unavailable = connectionUnavailableReason(loaded);
  if (unavailable || !loaded) {
    return { kind: "skip", reason: unavailable ?? "Connection unavailable." };
  }
  const definition = findActionDefinition(loaded.provider.key, action.type);
  if (!definition) {
    return {
      kind: "skip",
      reason: `The action type "${action.type}" is no longer provided by ${loaded.provider.displayName}.`,
    };
  }
  const config = definition.configSchema.safeParse(action.config);
  if (!config.success) {
    return {
      kind: "skip",
      reason: "The action configuration is no longer valid. Edit the workflow.",
    };
  }
  const snapshot = await buildRunSnapshot(row.runId, event.data);
  if (!snapshot) {
    return { kind: "skip", reason: "The run no longer exists." };
  }
  const variables = snapshotTemplateVariables(snapshot);
  const result = await definition.execute({
    ...createProviderContext(loaded.runtime, LOG_PREFIX),
    config: config.data,
    run: snapshot,
    actionRunId: row.id,
    attempt,
    render: (template) => renderTemplate(template, variables),
  });
  return { kind: "result", result, secrets: loaded.runtime.secrets };
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
} {
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

/** run.triggered selects the pre actions, the other events post actions. */
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

function connectionUnavailableReason(
  loaded: LoadedConnection | null
): string | null {
  if (!loaded) {
    return "The connection was removed or its credentials can no longer be read.";
  }
  if (loaded.record.status === IntegrationConnectionStatus.Disabled) {
    return `The connection "${loaded.record.name}" is disabled.`;
  }
  return null;
}

function groupByRun(
  rows: WorkflowActionRun[]
): Map<string, WorkflowActionRun[]> {
  const byRun = new Map<string, WorkflowActionRun[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  return byRun;
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
