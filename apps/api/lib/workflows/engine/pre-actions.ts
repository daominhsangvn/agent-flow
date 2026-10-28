import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  WORKFLOW_EMAIL_LABEL,
} from "@repo/api/src/types/workflow-email";
import { type WorkflowActionRun, withDb } from "@repo/database";
import { listIntegrationProviders } from "@/lib/integrations/registry";
import {
  compareActionRunOrder,
  isFinalActionRunStatus,
} from "./action-run-order";
import {
  advanceActionRun,
  hasEnabledPreActions,
  requeueStaleActionRuns,
} from "./actions";
import { runError } from "./errors";
import { type StepOutcome, transition } from "./step-outcome";

/**
 * The pre_actions step of the run state machine (docs/workflows.md "Run state
 * machine"). The run enters it from ingesting once the item is imported and
 * the run's documents exist (enterPreActions), so an instruction's agent has
 * the run's workspace; it goes back to ingesting when every row is final.
 * The pre action runs of the current cycle execute one at a time, in action
 * order, inline under the run lease, with the executor and retry/backoff
 * rules of the post-action outbox (actions.ts#advanceActionRun).
 *
 * The first row that is not final decides: due -> execute it now and go on
 * with the next row; waiting for its backoff, for its agent (an instruction)
 * or running in a worker that may still be alive -> stop, the scheduler tick
 * advances the run again later. The workflow.triggered rows are enqueued due
 * at the transition time, which is the advance's `now`, so a new run executes
 * them in the same call.
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

/**
 * From ingesting: the outcome that runs this cycle's workflow.triggered
 * actions first (enqueuing them the first time), or null when they are done
 * or the workflow has none.
 */
export async function enterPreActions(run: {
  id: string;
  organizationId: string;
  workflowId: string;
  cycle: number;
}): Promise<StepOutcome | null> {
  const rows = await withDb((db) =>
    db.workflowActionRun.findMany({
      where: {
        runId: run.id,
        cycle: run.cycle,
        stage: WorkflowActionStage.Pre,
      },
      select: { status: true },
    })
  );
  if (rows.length > 0) {
    return rows.every((row) => isFinalActionRunStatus(row.status))
      ? null
      : transition(WorkflowRunStatus.PreActions);
  }
  return (await hasEnabledPreActions(run))
    ? transition(WorkflowRunStatus.PreActions, [WorkflowRunEvent.Triggered])
    : null;
}

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

const WAIT_ROW: RowState = { kind: RowStateKind.Wait };

/**
 * A final row as it is; a due pending row executed now and a waiting one
 * checked (under a renewed lease); anything else waits.
 */
async function settlePreActionRun(
  row: PreActionRow,
  context: PreActionsContext
): Promise<RowState> {
  if (isFinalActionRunStatus(row.status)) {
    return finalRow(row.status, row.lastError);
  }
  const due =
    row.status === WorkflowActionRunStatus.Pending &&
    row.nextAttemptAt.getTime() <= context.now.getTime();
  const actionable = due || row.status === WorkflowActionRunStatus.Waiting;
  if (!(actionable && (await context.renewLease()))) {
    return WAIT_ROW;
  }
  const settlement = await advanceActionRun(row, context.now);
  if (!(settlement && isFinalActionRunStatus(settlement.status))) {
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

/** This cycle's pre rows in action order; removed actions last. */
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
    })
  );
  return [...rows].sort(compareActionRunOrder);
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
  if (actionType === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return "Instruction";
  }
  if (actionType === WORKFLOW_EMAIL_ACTION_TYPE) {
    return WORKFLOW_EMAIL_LABEL;
  }
  for (const provider of listIntegrationProviders()) {
    const action = provider.actions.find((entry) => entry.key === actionType);
    if (action) {
      return action.displayName;
    }
  }
  return actionType;
}
