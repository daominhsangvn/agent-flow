import { IntegrationToolCallStatus } from "@repo/api/src/types/integration-tools";
import type { WorkflowCaseCounts } from "@repo/api/src/types/workflow";
import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowInstructionOperationStatus,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";

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
  [WorkflowRunStatus.PreActions]: "Running triggered actions",
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
  [WorkflowRunEvent.Triggered]: "Trigger received",
  [WorkflowRunEvent.Started]: "Run started",
  [WorkflowRunEvent.PlanStarted]: "Planning started",
  [WorkflowRunEvent.PlanReady]: "Plan ready",
  [WorkflowRunEvent.NeedsInput]: "Needs input",
  [WorkflowRunEvent.ExecuteStarted]: "Implementation started",
  [WorkflowRunEvent.ExecuteCompleted]: "Implementation done",
  [WorkflowRunEvent.Succeeded]: "Run succeeded",
  [WorkflowRunEvent.Failed]: "Run failed",
};

export const WORKFLOW_RUN_EVENT_DESCRIPTIONS: Record<WorkflowRunEvent, string> =
  {
    [WorkflowRunEvent.Triggered]:
      "A trigger fired and the item was imported. Its actions run in order before the agent team starts; a failure stops the run unless continueOnError is true.",
    [WorkflowRunEvent.Started]:
      "The agent team picked up the item (once per run, when its first step starts).",
    [WorkflowRunEvent.PlanStarted]:
      "PLAN started writing the implementation plan; again on every re-plan.",
    [WorkflowRunEvent.PlanReady]: "The implementation plan was written.",
    [WorkflowRunEvent.NeedsInput]:
      "The plan or a process step has open questions, or a step waits for an approval: the run waits for a person.",
    [WorkflowRunEvent.ExecuteStarted]:
      "EXECUTE (or a process step that pushes) started implementing the plan.",
    [WorkflowRunEvent.ExecuteCompleted]:
      "The implementation finished (EXECUTE, or a process step that pushes): the changes are on the run's branch.",
    [WorkflowRunEvent.Succeeded]:
      "The run finished: the plan is ready (plan mode) or the changes are pushed (plan and implement). A create pull request action on this event opens the pull requests.",
    [WorkflowRunEvent.Failed]: "The run could not be completed.",
  };

/**
 * Every run event in lifecycle order. Post action lists use
 * `WORKFLOW_POST_ACTION_EVENTS` (the same order without workflow.triggered).
 */
export const WORKFLOW_RUN_EVENT_ORDER: readonly WorkflowRunEvent[] = [
  WorkflowRunEvent.Triggered,
  WorkflowRunEvent.Started,
  WorkflowRunEvent.PlanStarted,
  WorkflowRunEvent.PlanReady,
  WorkflowRunEvent.NeedsInput,
  WorkflowRunEvent.ExecuteStarted,
  WorkflowRunEvent.ExecuteCompleted,
  WorkflowRunEvent.Succeeded,
  WorkflowRunEvent.Failed,
];

export const WORKFLOW_ACTION_RUN_STATUS_LABELS: Record<
  WorkflowActionRunStatus,
  string
> = {
  [WorkflowActionRunStatus.Pending]: "Pending",
  [WorkflowActionRunStatus.Running]: "Running",
  [WorkflowActionRunStatus.Waiting]: "Agent at work",
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
  [WorkflowActionRunStatus.Waiting]: "ai",
  [WorkflowActionRunStatus.Succeeded]: "success",
  [WorkflowActionRunStatus.Failed]: "error",
  [WorkflowActionRunStatus.Skipped]: "muted",
};

export const WORKFLOW_AGENT_MODE_LABELS: Record<WorkflowAgentMode, string> = {
  [WorkflowAgentMode.Plan]: "Plan only",
  [WorkflowAgentMode.PlanAndExecute]: "Plan and implement",
  [WorkflowAgentMode.Orchestrated]: "Orchestrator",
};

export const WORKFLOW_AGENT_MODE_DESCRIPTIONS: Record<
  WorkflowAgentMode,
  string
> = {
  [WorkflowAgentMode.Plan]:
    "The agent team writes an implementation plan for the item and stops. A person reviews the plan and starts the implementation.",
  [WorkflowAgentMode.PlanAndExecute]:
    "The agent team writes the plan, approves it automatically and implements it, opening a pull request.",
  [WorkflowAgentMode.Orchestrated]:
    "No run starts: each request goes to this workflow's orchestrator, which follows its rules (instructions), chooses the runners' commands and answers.",
};

/**
 * The engine only reads source systems (webhooks, polling, import). Every
 * change in Jira, Azure DevOps or Teams is an action the admin added.
 */
export const WORKFLOW_SOURCE_SYSTEMS_NOTICE =
  "AgentFlow never changes Jira, Azure DevOps or Teams on its own - only the actions you add here do.";

export const WORKFLOW_ACTION_STAGE_LABELS: Record<WorkflowActionStage, string> =
  {
    [WorkflowActionStage.Pre]: "Before agents",
    [WorkflowActionStage.Post]: "After",
  };

/** Titles of the failed workflow and run operations (toast and inline). */
export const WorkflowMutationErrorTitle = {
  Create: "Couldn't create the workflow",
  Update: "Couldn't save the workflow",
  SetEnabled: "Couldn't turn the workflow on or off",
  Delete: "Couldn't delete the workflow",
  StartRun: "Couldn't start the run",
  CancelRun: "Couldn't cancel the run",
  RetryRun: "Couldn't retry the run",
  RetryActionRun: "Couldn't retry the action",
  AnswerQuestions: "Couldn't send the answers",
  DecideApproval: "Couldn't record the decision",
  DecideReview: "Couldn't record the review decision",
  DecideToolCall: "Couldn't decide the tool call",
} as const;
export type WorkflowMutationErrorTitle =
  (typeof WorkflowMutationErrorTitle)[keyof typeof WorkflowMutationErrorTitle];

/** How an integration tool call of an instruction's agent went (run page). */
export const WORKFLOW_INSTRUCTION_OPERATION_STATUS_LABELS: Record<
  WorkflowInstructionOperationStatus,
  string
> = {
  [WorkflowInstructionOperationStatus.Succeeded]: "done",
  [WorkflowInstructionOperationStatus.Failed]: "failed",
  [WorkflowInstructionOperationStatus.Skipped]: "skipped",
  [WorkflowInstructionOperationStatus.NotRun]: "not run",
  [WorkflowInstructionOperationStatus.PendingApproval]: "waiting for approval",
};

/** How an agent's integration tool call went (run page). */
export const WORKFLOW_TOOL_CALL_STATUS_LABELS: Record<
  IntegrationToolCallStatus,
  string
> = {
  [IntegrationToolCallStatus.Running]: "Running",
  [IntegrationToolCallStatus.Succeeded]: "Done",
  [IntegrationToolCallStatus.Failed]: "Failed",
  [IntegrationToolCallStatus.Refused]: "Refused",
  [IntegrationToolCallStatus.PendingApproval]: "Waiting for approval",
  [IntegrationToolCallStatus.Rejected]: "Rejected",
};

/** The action label of an instruction (it is no provider's action type). */
export const WORKFLOW_INSTRUCTION_LABEL = "Instruction";

export function describeCaseCount(total: number): string {
  return total === 1 ? "1 case" : `${total} cases`;
}

export function describeWorkflowCaseActivity(
  counts: WorkflowCaseCounts
): string {
  if (counts.total === 0) {
    return "No cases yet";
  }
  const base = `${describeCaseCount(counts.total)} (${counts.open} open)`;
  if (counts.lastActivityAt === null) {
    return base;
  }
  return `${base} · last activity ${formatRelativeTime(counts.lastActivityAt)}`;
}
