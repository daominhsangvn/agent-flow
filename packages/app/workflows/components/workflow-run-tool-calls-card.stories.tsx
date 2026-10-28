import {
  IntegrationToolCallStatus,
  type WorkflowRunToolCall,
} from "@repo/api/src/types/integration-tools";
import type { Meta, StoryObj } from "@storybook/react";
import { WorkflowRunToolCallsCard } from "./workflow-run-tool-calls-card";

const CALL: WorkflowRunToolCall = {
  id: "call-1",
  tool: "microsoft_teams_post_message",
  operationType: "microsoft_teams.post_message",
  connectionKey: "teams-release",
  input: { message: "Shipped JB-7: login works again on Safari." },
  status: IntegrationToolCallStatus.PendingApproval,
  externalRef: null,
  error: null,
  actionRunId: "ar-1",
  stepId: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-10-13T10:00:00.000Z"),
};

const meta = {
  title: "App Core/Workflows/Run Tool Calls Card",
  component: WorkflowRunToolCallsCard,
  args: {
    runId: "run-1",
    isAdmin: true,
    stepName: (stepId: string) => (stepId === "triage" ? "Triage" : stepId),
    toolCalls: [
      {
        ...CALL,
        id: "call-0",
        tool: "source_item_get",
        operationType: null,
        connectionKey: "jira-customer",
        input: {},
        status: IntegrationToolCallStatus.Succeeded,
        stepId: "triage",
        actionRunId: null,
      },
      CALL,
      {
        ...CALL,
        id: "call-2",
        tool: "source_item_transition",
        operationType: "jira.transition_issue",
        connectionKey: "jira-customer",
        input: { transitionName: "Shipped" },
        status: IntegrationToolCallStatus.Failed,
        error: 'No transition "Shipped". Available: In Progress, Done',
      },
      {
        ...CALL,
        id: "call-3",
        status: IntegrationToolCallStatus.Rejected,
        decidedBy: "Ada Admin",
        decidedAt: new Date("2026-10-13T10:05:00.000Z"),
      },
    ],
  },
} satisfies Meta<typeof WorkflowRunToolCallsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingForApproval: Story = {};

export const ReadOnlyMember: Story = { args: { isAdmin: false } };
