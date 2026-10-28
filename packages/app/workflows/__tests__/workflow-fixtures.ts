import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import { DocumentType } from "@repo/api/src/types/document";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  type SaveWorkflowInput,
  type Workflow,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowRunDetail,
  WorkflowRunEvent,
  WorkflowRunStatus,
  type WorkflowRunSummary,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import {
  JIRA_ADD_COMMENT,
  JIRA_CONNECTION_ID,
  JIRA_ISSUE_ASSIGNED,
  JIRA_KEY,
  JIRA_TRANSITION_ISSUE,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
} from "../../integrations/__tests__/integration-fixtures";

/** Workflows and runs shared by the workflows tests (UUID ids, as the contracts require). */

export const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
export const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
export const COMPUTE_TARGET_ID = "77777777-7777-4777-8777-777777777777";
export const RUN_AS_USER_ID = "88888888-8888-4888-8888-888888888888";
export const TRIGGER_ID = "99999999-9999-4999-8999-999999999999";
export const ACTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const PRE_ACTION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const PRE_ACTION_RUN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ACTION_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const LOOP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const LIVE_SESSION_ID = "12121212-1212-4121-8121-121212121212";
export const ENDED_SESSION_ID = "13131313-1313-4131-8131-131313131313";

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: WORKFLOW_ID,
    name: "Implement Jira requirements",
    description: "BA assigns to the bot",
    enabled: true,
    project: { id: PROJECT_ID, name: "Web" },
    runAsUser: { id: RUN_AS_USER_ID, name: "Ada Admin", email: "ada@acme.dev" },
    agent: {
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
      computeTargetId: COMPUTE_TARGET_ID,
      runners: [],
      repository: null,
      prd: workflowPrdRuleSchema.parse({}),
      instructions: "Use pnpm.",
      titleTemplate: "{{source.key}}: {{source.title}}",
      process: null,
    },
    triggers: [
      {
        id: TRIGGER_ID,
        projectId: PROJECT_ID,
        connectionKey: JIRA_KEY,
        projectConnectionId: `pc-${JIRA_KEY}-${PROJECT_ID}`,
        connectionId: JIRA_CONNECTION_ID,
        builtInHttp: false,
        type: JIRA_ISSUE_ASSIGNED,
        config: { projectKeys: ["PROJ"], label: "ai" },
        enabled: true,
        position: 0,
      },
    ],
    httpEndpointConnectionId: null,
    // Post action listed first on purpose: the UI orders by stage, then position.
    actions: [
      {
        id: ACTION_ID,
        connectionKey: TEAMS_KEY,
        connectionId: null,
        automaticConnection: false,
        type: TEAMS_POST_MESSAGE,
        config: { message: "{{summary}}" },
        builtInHttp: false,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Failed, WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
        position: 0,
      },
      {
        id: PRE_ACTION_ID,
        connectionKey: JIRA_KEY,
        connectionId: null,
        automaticConnection: false,
        type: JIRA_TRANSITION_ISSUE,
        config: { transition: "In Progress" },
        builtInHttp: false,
        stage: WorkflowActionStage.Pre,
        events: [WorkflowRunEvent.Triggered],
        continueOnError: true,
        enabled: true,
        position: 0,
      },
    ],
    runCounts: { total: 4, active: 1, succeeded: 2, failed: 1 },
    lastRunAt: new Date("2026-10-01T09:00:00.000Z"),
    caseCounts: null,
    createdAt: new Date("2026-09-01T09:00:00.000Z"),
    updatedAt: new Date("2026-09-02T09:00:00.000Z"),
    ...overrides,
  };
}

export function makeRunSummary(
  overrides: Partial<WorkflowRunSummary> = {}
): WorkflowRunSummary {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "Implement Jira requirements",
    triggerId: TRIGGER_ID,
    triggerType: JIRA_ISSUE_ASSIGNED,
    status: WorkflowRunStatus.Planning,
    source: {
      provider: IntegrationProviderKey.Jira,
      externalId: "10001",
      key: "PROJ-7",
      title: "Add CSV export",
      url: "https://acme.atlassian.net/browse/PROJ-7",
    },
    pullRequests: [],
    error: null,
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    updatedAt: new Date("2026-10-01T09:05:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

export function makeRunDetail(
  overrides: Partial<WorkflowRunDetail> = {}
): WorkflowRunDetail {
  return {
    ...makeRunSummary(),
    feature: {
      id: "f-1",
      slug: "ISS-42",
      title: "PROJ-7: Add CSV export",
      type: DocumentType.Feature,
    },
    sourceClassification: null,
    plan: { id: "p-1", slug: "PLN-9", title: "Plan: Add CSV export" },
    documents: [],
    branchName: null,
    loops: [
      {
        loopId: LOOP_ID,
        command: LoopCommand.Plan,
        status: LoopStatus.Running,
        adopted: false,
        stepId: null,
        prUrl: null,
        startedAt: new Date("2026-10-01T09:01:00.000Z"),
        completedAt: null,
      },
    ],
    sessions: [
      {
        id: LIVE_SESSION_ID,
        slug: "SES-12",
        name: "Plan PROJ-7",
        loopId: LOOP_ID,
        command: LoopCommand.Plan,
        stepId: null,
        status: DISPLAYED_SESSION_STATUS.ACTIVE,
        harness: "claude-code",
        model: "claude-opus-5-5",
        startedAt: new Date("2026-10-01T09:02:00.000Z"),
        lastActivityAt: new Date("2026-10-01T09:05:00.000Z"),
        endedAt: null,
      },
      {
        id: ENDED_SESSION_ID,
        slug: "SES-11",
        name: "Plan PROJ-7 (first attempt)",
        loopId: LOOP_ID,
        command: LoopCommand.Plan,
        stepId: null,
        status: DISPLAYED_SESSION_STATUS.INACTIVE,
        harness: "claude-code",
        model: null,
        startedAt: new Date("2026-10-01T09:01:00.000Z"),
        lastActivityAt: new Date("2026-10-01T09:01:30.000Z"),
        endedAt: new Date("2026-10-01T09:01:40.000Z"),
      },
    ],
    // Post row listed first on purpose: the run detail shows pre rows first.
    actionRuns: [
      {
        id: ACTION_RUN_ID,
        actionId: ACTION_ID,
        actionType: JIRA_ADD_COMMENT,
        stage: WorkflowActionStage.Post,
        event: WorkflowRunEvent.Started,
        cycle: 1,
        status: WorkflowActionRunStatus.Failed,
        attempts: 5,
        lastError: "Jira returned 403",
        externalRef: null,
        instruction: null,
        completedAt: null,
        createdAt: new Date("2026-10-01T09:01:00.000Z"),
      },
      {
        id: PRE_ACTION_RUN_ID,
        actionId: PRE_ACTION_ID,
        actionType: JIRA_TRANSITION_ISSUE,
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        cycle: 1,
        status: WorkflowActionRunStatus.Succeeded,
        attempts: 1,
        lastError: null,
        externalRef: null,
        instruction: null,
        completedAt: new Date("2026-10-01T09:00:30.000Z"),
        createdAt: new Date("2026-10-01T09:00:10.000Z"),
      },
    ],
    process: null,
    toolCalls: [],
    retryStep: null,
    ...overrides,
  };
}

/** The save body of `makeWorkflow()`: what saving its YAML unchanged sends. */
export function makeSaveWorkflowInput(): SaveWorkflowInput {
  return {
    name: "Implement Jira requirements",
    description: "BA assigns to the bot",
    enabled: true,
    projectId: PROJECT_ID,
    runAsUserId: RUN_AS_USER_ID,
    agent: {
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
      computeTargetId: COMPUTE_TARGET_ID,
      runners: [],
      repository: null,
      prd: workflowPrdRuleSchema.parse({}),
      instructions: "Use pnpm.",
      titleTemplate: "{{source.key}}: {{source.title}}",
      process: null,
    },
    triggers: [
      {
        id: TRIGGER_ID,
        connectionKey: JIRA_KEY,
        type: JIRA_ISSUE_ASSIGNED,
        config: { projectKeys: ["PROJ"], label: "ai" },
        enabled: true,
      },
    ],
    actions: [
      {
        id: PRE_ACTION_ID,
        connectionKey: JIRA_KEY,
        automaticConnection: false,
        type: JIRA_TRANSITION_ISSUE,
        config: { transition: "In Progress" },
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: true,
        enabled: true,
      },
      {
        id: ACTION_ID,
        connectionKey: TEAMS_KEY,
        automaticConnection: false,
        type: TEAMS_POST_MESSAGE,
        config: { message: "{{summary}}" },
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded, WorkflowRunEvent.Failed],
        continueOnError: false,
        enabled: true,
      },
    ],
  };
}
