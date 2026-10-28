import {
  type OrchestratorCaseDetail,
  OrchestratorCaseStatus,
  OrchestratorConversationStatus,
  OrchestratorDecisionStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import type { Meta, StoryObj } from "@storybook/react";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { OrchestratorCaseDetailView } from "./orchestrator-case-detail-view";

const CASE_ID = "01CASE0000000000000000000";
const CONVERSATION_ID = "01CONV0000000000000000000";
const TURN_ID = "01TURN0000000000000000000";

const fixture: OrchestratorCaseDetail = {
  id: CASE_ID,
  projectId: "01PROJECT000000000000000",
  workflowId: "01WORKFLOW0000000000000",
  title: "PROJ-7 login fails on Safari",
  sourceKey: "jira:PROJ-7",
  status: OrchestratorCaseStatus.Open,
  conversationCount: 1,
  pendingDecisionCount: 1,
  activeTaskCount: 1,
  turnRunning: true,
  createdAt: "2026-10-26T08:00:00.000Z",
  updatedAt: "2026-10-26T08:10:00.000Z",
  notes: "Reproduced on Safari 17. Waiting for the plan approval.",
  project: { id: "01PROJECT000000000000000", name: "Web" },
  workflow: { id: "01WORKFLOW0000000000000", name: "Orchestrated" },
  conversations: [
    {
      id: CONVERSATION_ID,
      channelKey: "jira:PROJ-7",
      status: OrchestratorConversationStatus.Turn,
      createdAt: "2026-10-26T08:00:00.000Z",
      messages: [
        {
          id: "01MSG00000000000000000001",
          conversationId: CONVERSATION_ID,
          origin: OrchestratorMessageOrigin.External,
          kind: OrchestratorMessageKind.Message,
          actor: "Ann",
          text: "@bot please look at the login failure.",
          turnId: TURN_ID,
          createdAt: "2026-10-26T08:00:00.000Z",
        },
      ],
      turns: [
        {
          id: TURN_ID,
          conversationId: CONVERSATION_ID,
          status: OrchestratorTurnStatus.Running,
          ended: null,
          summary: null,
          error: null,
          usage: null,
          runnerName: "runner-dev",
          startedAt: "2026-10-26T08:01:00.000Z",
          finishedAt: null,
        },
      ],
    },
  ],
  tasks: [
    {
      id: "01TASK0000000000000000001",
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      command: "/plan",
      args: "PROJ-7",
      prompt: "Plan the fix",
      mode: "plan",
      runnerName: "runner-dev",
      computeTargetId: null,
      status: OrchestratorTaskStatus.Failed,
      fork: false,
      resumeTaskId: null,
      loopId: "01LOOP0000000000000000001",
      reply: null,
      questions: [],
      error: "The runner lost its session.",
      waiting: null,
      createdAt: "2026-10-26T08:02:00.000Z",
      finishedAt: "2026-10-26T08:05:00.000Z",
    },
  ],
  waits: [
    {
      id: "01WAIT0000000000000000001",
      conversationId: CONVERSATION_ID,
      kind: OrchestratorWaitKind.All,
      taskIds: ["01TASK0000000000000000001"],
      deadline: null,
      wakeOnFailure: true,
      firedAt: null,
      createdAt: "2026-10-26T08:02:00.000Z",
    },
  ],
  decisions: [
    {
      id: "01DEC00000000000000000001",
      conversationId: CONVERSATION_ID,
      question: "Approve the plan for PROJ-7?",
      status: OrchestratorDecisionStatus.Pending,
      via: null,
      decidedBy: null,
      comment: null,
      decidedAt: null,
      createdAt: "2026-10-26T08:06:00.000Z",
    },
  ],
};

const caseRoutes: FixtureRoute[] = [
  { method: "GET", path: "/orchestrator/cases/*", respond: () => fixture },
  { method: "POST", path: "/orchestrator/decisions/*", respond: () => ({}) },
];

const meta: Meta<typeof OrchestratorCaseDetailView> = {
  title: "App Core/Orchestrator/Case Detail View",
  component: OrchestratorCaseDetailView,
  parameters: { appCore: { apiRoutes: caseRoutes } },
  args: { caseId: CASE_ID, isAdmin: true },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Admin: Story = {};

export const Member: Story = {
  args: { isAdmin: false },
};
