import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { z } from "zod";

/**
 * Readable explanations of the codes a workflow run can fail with
 * (`WorkflowRun.error.code`). The engine's own message (e.g. "Pre action Move
 * issue failed: Jira returned 403") is shown next to it as the detail.
 */
export const WORKFLOW_RUN_ERROR_MESSAGES: Record<WorkflowRunErrorCode, string> =
  {
    [WorkflowRunErrorCode.WorkflowDisabled]: "The workflow was disabled",
    [WorkflowRunErrorCode.ProjectMissing]:
      "The workflow's project no longer exists",
    [WorkflowRunErrorCode.RunAsUserMissing]:
      "The run-as user is no longer an active member of the organization",
    [WorkflowRunErrorCode.AgentConfigInvalid]:
      "The agent team configuration is invalid",
    [WorkflowRunErrorCode.PreActionFailed]:
      "A pre action failed, so the agent team did not start",
    [WorkflowRunErrorCode.SourceFetchFailed]:
      "Couldn't read the item from the source system",
    [WorkflowRunErrorCode.DocumentCreateFailed]:
      "Couldn't create the Issue or the implementation plan",
    [WorkflowRunErrorCode.ComputeTargetUnavailable]:
      "The compute target is offline or not available to the run-as user",
    [WorkflowRunErrorCode.RunnerBusy]:
      "The personal runner is running another task; the step starts when it is free",
    [WorkflowRunErrorCode.SigningRequired]:
      "The compute target requires a browser signature, which unattended runs cannot provide",
    [WorkflowRunErrorCode.NoRepository]:
      "No repository is configured for the project",
    [WorkflowRunErrorCode.RepositoryNotAllowed]:
      "The repository is not in the project's repository pool",
    [WorkflowRunErrorCode.ConcurrencyLimit]:
      "The run-as user reached the limit of concurrent loops",
    [WorkflowRunErrorCode.LoopAlreadyActive]:
      "Another loop is already running on the plan",
    [WorkflowRunErrorCode.DocumentBlocked]:
      "The plan is blocked and cannot run a loop",
    [WorkflowRunErrorCode.DispatchFailed]:
      "Couldn't hand the loop to the compute target",
    [WorkflowRunErrorCode.PlanFailed]: "The planning loop failed",
    [WorkflowRunErrorCode.ExecuteFailed]: "The implementation loop failed",
    [WorkflowRunErrorCode.StepFailed]: "A step of the project's process failed",
    [WorkflowRunErrorCode.ApprovalRejected]: "An approval step was rejected",
    [WorkflowRunErrorCode.ReviewRejected]: "A step under review was rejected",
    [WorkflowRunErrorCode.PlanStateUnavailable]:
      "The plan's working state is not available for implementation",
    [WorkflowRunErrorCode.PhaseTimeout]: "The run took too long and timed out",
    [WorkflowRunErrorCode.Cancelled]: "The run was cancelled",
    [WorkflowRunErrorCode.InternalError]: "An internal error stopped the run",
  };

/** A run error ready to show: a readable title and the engine's detail message. */
export type WorkflowRunErrorText = {
  title: string;
  detail: string;
};

/**
 * The readable text of a run error. A code this UI does not know (a newer
 * server) falls back to the raw code as the title; the detail is always the
 * engine's message.
 */
export function describeWorkflowRunError(
  error: WorkflowRunError
): WorkflowRunErrorText {
  const parsed = workflowRunErrorCodeSchema.safeParse(error.code);
  return {
    title: parsed.success
      ? WORKFLOW_RUN_ERROR_MESSAGES[parsed.data]
      : error.code,
    detail: error.message,
  };
}

const workflowRunErrorCodeSchema = z.enum(WorkflowRunErrorCode);
