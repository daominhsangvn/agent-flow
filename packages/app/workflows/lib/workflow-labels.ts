import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";

/** Badge tones used by the workflows UI (a subset of the design-system Badge variants). */
export type WorkflowBadgeTone =
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "info"
  | "ai";

export const WORKFLOW_RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  [WorkflowRunStatus.Received]: "Received",
  [WorkflowRunStatus.PreActions]: "Running pre actions",
  [WorkflowRunStatus.Ingesting]: "Importing",
  [WorkflowRunStatus.Planning]: "Planning",
  [WorkflowRunStatus.Executing]: "Implementing",
  [WorkflowRunStatus.Running]: "Running step",
  [WorkflowRunStatus.NeedsInput]: "Needs input",
  [WorkflowRunStatus.NeedsApproval]: "Waiting for approval",
  [WorkflowRunStatus.Succeeded]: "Succeeded",
  [WorkflowRunStatus.Failed]: "Failed",
  [WorkflowRunStatus.Cancelled]: "Cancelled",
};

export const WORKFLOW_RUN_STATUS_TONES: Record<
  WorkflowRunStatus,
  WorkflowBadgeTone
> = {
  [WorkflowRunStatus.Received]: "muted",
  [WorkflowRunStatus.PreActions]: "info",
  [WorkflowRunStatus.Ingesting]: "info",
  [WorkflowRunStatus.Planning]: "ai",
  [WorkflowRunStatus.Executing]: "ai",
  [WorkflowRunStatus.Running]: "ai",
  [WorkflowRunStatus.NeedsInput]: "warning",
  [WorkflowRunStatus.NeedsApproval]: "warning",
  [WorkflowRunStatus.Succeeded]: "success",
  [WorkflowRunStatus.Failed]: "error",
  [WorkflowRunStatus.Cancelled]: "muted",
};

export const WORKFLOW_RUN_EVENT_LABELS: Record<WorkflowRunEvent, string> = {
  [WorkflowRunEvent.Triggered]: "Trigger received (pre actions)",
  [WorkflowRunEvent.Started]: "Run started",
  [WorkflowRunEvent.PlanReady]: "Plan ready",
  [WorkflowRunEvent.NeedsInput]: "Needs input",
  [WorkflowRunEvent.Succeeded]: "Run succeeded",
  [WorkflowRunEvent.Failed]: "Run failed",
};

export const WORKFLOW_RUN_EVENT_DESCRIPTIONS: Record<WorkflowRunEvent, string> =
  {
    [WorkflowRunEvent.Triggered]:
      "A trigger fired. Pre actions run on it, before the agent team starts.",
    [WorkflowRunEvent.Started]: "The agent team picked up the item.",
    [WorkflowRunEvent.PlanReady]: "The implementation plan was written.",
    [WorkflowRunEvent.NeedsInput]:
      "The plan has open questions and the run waits for a person.",
    [WorkflowRunEvent.Succeeded]:
      "Plan mode: the plan is ready. Plan and implement: the pull request is open.",
    [WorkflowRunEvent.Failed]: "The run could not be completed.",
  };

/**
 * Every run event in lifecycle order. Post action checkbox lists use
 * `WORKFLOW_POST_ACTION_EVENTS` (the same order without run.triggered).
 */
export const WORKFLOW_RUN_EVENT_ORDER: readonly WorkflowRunEvent[] = [
  WorkflowRunEvent.Triggered,
  WorkflowRunEvent.Started,
  WorkflowRunEvent.PlanReady,
  WorkflowRunEvent.NeedsInput,
  WorkflowRunEvent.Succeeded,
  WorkflowRunEvent.Failed,
];

export const WORKFLOW_ACTION_RUN_STATUS_LABELS: Record<
  WorkflowActionRunStatus,
  string
> = {
  [WorkflowActionRunStatus.Pending]: "Pending",
  [WorkflowActionRunStatus.Running]: "Running",
  [WorkflowActionRunStatus.Succeeded]: "Succeeded",
  [WorkflowActionRunStatus.Failed]: "Failed",
  [WorkflowActionRunStatus.Skipped]: "Skipped",
};

export const WORKFLOW_ACTION_RUN_STATUS_TONES: Record<
  WorkflowActionRunStatus,
  WorkflowBadgeTone
> = {
  [WorkflowActionRunStatus.Pending]: "muted",
  [WorkflowActionRunStatus.Running]: "info",
  [WorkflowActionRunStatus.Succeeded]: "success",
  [WorkflowActionRunStatus.Failed]: "error",
  [WorkflowActionRunStatus.Skipped]: "muted",
};

export const WORKFLOW_AGENT_MODE_LABELS: Record<WorkflowAgentMode, string> = {
  [WorkflowAgentMode.Plan]: "Plan only",
  [WorkflowAgentMode.PlanAndExecute]: "Plan and implement",
};

export const WORKFLOW_AGENT_MODE_DESCRIPTIONS: Record<
  WorkflowAgentMode,
  string
> = {
  [WorkflowAgentMode.Plan]:
    "The agent team writes an implementation plan for the item and stops. A person reviews the plan and starts the implementation.",
  [WorkflowAgentMode.PlanAndExecute]:
    "The agent team writes the plan, approves it automatically and implements it, opening a pull request.",
};

/**
 * The engine only reads source systems (webhooks, polling, import). Every
 * change in Jira, Azure DevOps or Teams is an action the admin added.
 */
export const WORKFLOW_SOURCE_SYSTEMS_NOTICE =
  "AgentFlow never changes Jira, Azure DevOps or Teams on its own - only the actions you add here do.";

export const WORKFLOW_ACTION_STAGE_LABELS: Record<WorkflowActionStage, string> =
  {
    [WorkflowActionStage.Pre]: "Pre",
    [WorkflowActionStage.Post]: "Post",
  };

/** Titles of the failed workflow and run operations (toast and inline). */
export const WorkflowMutationErrorTitle = {
  Create: "Couldn't create the workflow",
  Update: "Couldn't save the workflow",
  SetEnabled: "Couldn't turn the workflow on or off",
  Delete: "Couldn't delete the workflow",
  StartRun: "Couldn't start the run",
  CancelRun: "Couldn't cancel the run",
  RetryActionRun: "Couldn't retry the action",
  AnswerQuestions: "Couldn't send the answers",
  DecideApproval: "Couldn't record the decision",
} as const;
export type WorkflowMutationErrorTitle =
  (typeof WorkflowMutationErrorTitle)[keyof typeof WorkflowMutationErrorTitle];
