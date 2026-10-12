import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { type WorkflowActionRun, withDb } from "@repo/database";
import { listIntegrationProviders } from "@/lib/integrations/registry";
import { requeueStaleActionRuns, runActionRun } from "./actions";
import { runError } from "./errors";

/**
 * The pre_actions step of the run state machine (docs/workflows.md "Run state
 * machine"). The pre action runs of the current cycle execute one at a time,
 * in action position order, inline under the run lease, with the executor and
 * retry/backoff rules of the post-action outbox (actions.ts#runActionRun).
 *
 * The first row that is not final decides: due -> execute it now and go on
 * with the next row; waiting for its backoff (or running in a worker that may
 * still be alive) -> stop, the scheduler tick advances the run again later.
 * The run.triggered rows are enqueued due at the transition time, which is
 * the advance's `now`, so a new run executes them in the same call.
 * A failed row stops the run unless its action has continueOnError; skipped
 * rows (action removed, connection disabled, not applicable, ...) count as
 * done. Pre rows are never claimed by the outbox drain.
 *
 * Lease: the run lease (2 min) is renewed before every execution, and every
 * provider request is bounded by the ProviderHttp timeout (15 s by default),
 * so the lease covers each action. An action that kept issuing requests for
 * longer than the lease could see another worker take the run over; that
 * worker then finds the row running and waits until it is stale (10 min).
 */

export const PreActionsOutcomeKind = {
  /** Every pre row of the cycle is final: continue with the agent team. */
  Done: "done",
  /** A row waits for its next attempt (or the lease was lost): stop for now. */
  Wait: "wait",
  /** A pre action without continueOnError failed: the run fails. */
  Failed: "failed",
} as const;
export type PreActionsOutcomeKind =
  (typeof PreActionsOutcomeKind)[keyof typeof PreActionsOutcomeKind];

export type PreActionsOutcome =
  | { kind: typeof PreActionsOutcomeKind.Done }
  | { kind: typeof PreActionsOutcomeKind.Wait }
  | { kind: typeof PreActionsOutcomeKind.Failed; error: WorkflowRunError };

export type PreActionsContext = {
  run: { id: string; cycle: number };
  now: Date;
  /** Extends the run lease before an execution; false when the lease was lost. */
  renewLease(): Promise<boolean>;
};

export async function runPreActions(
  context: PreActionsContext
): Promise<PreActionsOutcome> {
  // Rows left running by a worker that died go back to pending (or failed
  // when out of attempts); the outbox requeue only handles post rows.
  await requeueStaleActionRuns(context.now, {
    runId: context.run.id,
    stage: WorkflowActionStage.Pre,
  });
  const rows = await listPreActionRuns(context.run);
  for (const row of rows) {
    const state = await settlePreActionRun(row, context);
    if (state.kind === RowStateKind.Wait) {
      return { kind: PreActionsOutcomeKind.Wait };
    }
    if (state.failed && blocksRun(row)) {
      return {
        kind: PreActionsOutcomeKind.Failed,
        error: preActionError(row.actionType, state.lastError),
      };
    }
  }
  return { kind: PreActionsOutcomeKind.Done };
}

const RowStateKind = {
  Final: "final",
  Wait: "wait",
} as const;

type RowState =
  | {
      kind: typeof RowStateKind.Final;
      failed: boolean;
      lastError: string | null;
    }
  | { kind: typeof RowStateKind.Wait };

type PreActionRow = WorkflowActionRun & {
  action: { position: number; continueOnError: boolean } | null;
};

const FINAL_ACTION_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  WorkflowActionRunStatus.Succeeded,
  WorkflowActionRunStatus.Failed,
  WorkflowActionRunStatus.Skipped,
]);

const WAIT_ROW: RowState = { kind: RowStateKind.Wait };

/** A final row as it is, a due pending row executed now, anything else waits. */
async function settlePreActionRun(
  row: PreActionRow,
  context: PreActionsContext
): Promise<RowState> {
  if (FINAL_ACTION_RUN_STATUSES.has(row.status)) {
    return finalRow(row.status, row.lastError);
  }
  const due =
    row.status === WorkflowActionRunStatus.Pending &&
    row.nextAttemptAt.getTime() <= context.now.getTime();
  if (!(due && (await context.renewLease()))) {
    return WAIT_ROW;
  }
  const settlement = await runActionRun(row, context.now);
  if (!settlement || settlement.status === WorkflowActionRunStatus.Pending) {
    return WAIT_ROW;
  }
  return finalRow(settlement.status, settlement.lastError);
}

function finalRow(status: string, lastError: string | null): RowState {
  return {
    kind: RowStateKind.Final,
    failed: status === WorkflowActionRunStatus.Failed,
    lastError,
  };
}

/** This cycle's pre rows in action position order; removed actions last. */
async function listPreActionRuns(run: {
  id: string;
  cycle: number;
}): Promise<PreActionRow[]> {
  const rows = await withDb((db) =>
    db.workflowActionRun.findMany({
      where: {
        runId: run.id,
        cycle: run.cycle,
        stage: WorkflowActionStage.Pre,
      },
      include: {
        action: { select: { position: true, continueOnError: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  );
  return [...rows].sort(comparePreActionRows);
}

function comparePreActionRows(left: PreActionRow, right: PreActionRow) {
  if (left.action && right.action) {
    const byPosition = left.action.position - right.action.position;
    if (byPosition !== 0) {
      return byPosition;
    }
  } else if (left.action || right.action) {
    return left.action ? -1 : 1;
  }
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/** A pre action removed from the workflow no longer blocks the run. */
function blocksRun(row: PreActionRow): boolean {
  return row.action ? !row.action.continueOnError : false;
}

function preActionError(
  actionType: string,
  lastError: string | null
): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.PreActionFailed,
    `Pre action ${actionDisplayName(actionType)} failed: ${lastError ?? "Unknown error"}`
  );
}

/** Display name of the action type from the registry, else the type key. */
function actionDisplayName(actionType: string): string {
  for (const provider of listIntegrationProviders()) {
    const action = provider.actions.find((entry) => entry.key === actionType);
    if (action) {
      return action.displayName;
    }
  }
  return actionType;
}
