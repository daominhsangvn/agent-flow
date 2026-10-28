import {
  approvalFromSignal,
  nextProcessStep,
  type ProcessStep,
  ProcessStepType,
  type ReviewDecision,
  ReviewDecisionKind,
  type RunStepState,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { readRunStepState } from "./agent-step";
import { runError } from "./errors";
import { readRunProcessSnapshot } from "./process";
import { toJsonObject } from "./run-data";
import {
  type EngineRun,
  type RunTransitionData,
  type StepOutcome,
  transition,
} from "./step-outcome";

/**
 * Approval steps of a project process (ProcessStepType.Approval,
 * docs/workflows.md "Project process"): the run waits in needs_approval
 * (with input.needed for the post actions that notify people) until a
 * person decides in AgentFlow (POST /workflow-runs/{id}/approval). An
 * approval goes on to the next step; a rejection fails the run.
 */

/** The transition into an approval step. */
export function enterApprovalStep(input: {
  step: Extract<ProcessStep, { type: typeof ProcessStepType.Approval }>;
  events: WorkflowRunEvent[];
  data: RunTransitionData;
  now: Date;
  /**
   * Signals from the source item that arrived before the step (an approve
   * label added while the plan was still written): the first approval
   * decides the step at once, and nobody is notified of a wait.
   */
  pending?: readonly ReviewDecision[];
}): StepOutcome {
  const approved = input.pending?.find(
    (signal) => signal.kind === ReviewDecisionKind.Approve
  );
  const state: RunStepState = {
    waiting: null,
    approval: {
      stepId: input.step.id,
      requestedAt: input.now.toISOString(),
      decision: approved ? approvalFromSignal(approved) : null,
    },
  };
  return transition(
    WorkflowRunStatus.NeedsApproval,
    approved ? input.events : [...input.events, WorkflowRunEvent.NeedsInput],
    { ...input.data, stepState: toJsonObject(state) }
  );
}

export const ApprovalSettlementKind = {
  /** No decision yet. */
  Waiting: "waiting",
  Approved: "approved",
  Rejected: "rejected",
} as const;

export type ApprovalSettlement =
  | { kind: typeof ApprovalSettlementKind.Waiting }
  /** `next` null: the approval was the last step. */
  | { kind: typeof ApprovalSettlementKind.Approved; next: ProcessStep | null }
  | { kind: typeof ApprovalSettlementKind.Rejected; error: WorkflowRunError };

/** needs_approval: what the recorded decision leads to. */
export function settleApproval(run: EngineRun): ApprovalSettlement {
  const approval = readRunStepState(run.stepState)?.approval;
  const decision = approval?.decision;
  if (!(approval && decision)) {
    return { kind: ApprovalSettlementKind.Waiting };
  }
  const snapshot = readRunProcessSnapshot(run.process);
  const step = snapshot?.definition.steps.find(
    (candidate) =>
      candidate.id === approval.stepId &&
      candidate.type === ProcessStepType.Approval
  );
  const name = step?.name ?? approval.stepId;
  if (!decision.approved) {
    const reason = decision.comment ? `: ${decision.comment}` : ".";
    return {
      kind: ApprovalSettlementKind.Rejected,
      error: runError(
        WorkflowRunErrorCode.ApprovalRejected,
        `"${name}" was rejected${reason}`
      ),
    };
  }
  return {
    kind: ApprovalSettlementKind.Approved,
    next: snapshot
      ? nextProcessStep(snapshot.definition, approval.stepId)
      : null,
  };
}
