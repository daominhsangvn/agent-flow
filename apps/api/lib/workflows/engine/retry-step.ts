import { LoopCommand } from "@repo/api/src/types/loop";
import {
  type ProcessStep,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  WorkflowRunErrorCode,
  type WorkflowRunRetryStep,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { readRunProcessSnapshot } from "./process";
import { readRunError } from "./run-data";
import { findLatestRunLoop, type RunLoopState } from "./run-loops";

/**
 * Retry of a run's step (docs/workflows.md "Run state machine"): a workflow
 * administrator runs the plan, implement or agent step the run failed in
 * again (a failure outside the agents' work: an expired model token, an
 * offline computer), or the step it was cancelled in. The run keeps its documents, its approved plan and the
 * answers given so far; the step gets a new loop in a new cycle, so the
 * step's post actions (`execute.started`, ...) fire again. Pre actions and
 * the steps before the failed one do not run again.
 */

/** A failed run, or one an administrator cancelled while a step ran. */
export const RETRYABLE_RUN_STATUSES: ReadonlySet<string> =
  new Set<WorkflowRunStatus>([
    WorkflowRunStatus.Failed,
    WorkflowRunStatus.Cancelled,
  ]);

/** Steps that run a loop and can run it again. */
const RETRYABLE_STEP_TYPES: ReadonlySet<ProcessStep["type"]> = new Set([
  ProcessStepType.AgentFlowPlan,
  ProcessStepType.AgentFlowExecute,
  ProcessStepType.Agent,
]);

/** Failures a retry cannot undo: a person decided, or the workflow is off. */
const FINAL_ERROR_CODES: ReadonlySet<string> = new Set<WorkflowRunErrorCode>([
  WorkflowRunErrorCode.ApprovalRejected,
  WorkflowRunErrorCode.ReviewRejected,
  WorkflowRunErrorCode.WorkflowDisabled,
]);

/**
 * The step a failed or cancelled run would run again, or null when the run
 * did not stop in a loop step of a project process (the built-in flow, a
 * failure before planning, a rejection).
 */
export function findRetryableStep(run: {
  status: string;
  error: unknown;
  process?: unknown;
  stepId?: string | null;
}): ProcessStep | null {
  if (!RETRYABLE_RUN_STATUSES.has(run.status)) {
    return null;
  }
  const error = readRunError(run.error);
  if (error && FINAL_ERROR_CODES.has(error.code)) {
    return null;
  }
  const snapshot = readRunProcessSnapshot(run.process);
  const step = snapshot?.definition.steps.find(
    (candidate) => candidate.id === run.stepId
  );
  return step && RETRYABLE_STEP_TYPES.has(step.type) ? step : null;
}

/** The retry a run offers: its retryable step, and whether it can resume. */
export async function toRetryStep(
  runId: string,
  step: ProcessStep | null
): Promise<WorkflowRunRetryStep | null> {
  if (!step) {
    return null;
  }
  const resumable = (await findResumableLoop(runId, step)) !== null;
  return { id: step.id, name: step.name, resumable };
}

/**
 * The failed loop of an agent step whose session a retry can resume
 * (WorkflowRunRetryMode.Resume): the step's latest loop, when its computer
 * recorded the agent session. Null for AgentFlow plan/execute steps.
 */
export async function findResumableLoop(
  runId: string,
  step: ProcessStep
): Promise<RunLoopState | null> {
  if (step.type !== ProcessStepType.Agent) {
    return null;
  }
  const loop = await findLatestRunLoop(
    runId,
    LoopCommand.Step,
    undefined,
    step.id
  );
  return loop?.sessionId ? loop : null;
}
