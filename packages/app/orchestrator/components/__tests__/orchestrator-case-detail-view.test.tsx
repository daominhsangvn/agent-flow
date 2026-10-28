import {
  type OrchestratorCaseDetail,
  OrchestratorCaseStatus,
  OrchestratorConversationStatus,
  OrchestratorDecisionStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
} from "@repo/api/src/types/orchestrator";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorCaseDetailView } from "../orchestrator-case-detail-view";

const CASE_ID = "case-1";
const CONV = "conv-1";
const TURN = "turn-1";
const DECISION_ID = "dec-1";
const LOOP_ID = "loop-9";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as OrchestratorCaseDetail | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  decideMutate: vi.fn(),
}));

vi.mock("../../hooks/use-orchestrator-cases", () => ({
  useOrchestratorCase: () => mocks.query,
  useSetOrchestratorCaseStatus: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDecideOrchestratorDecision: () => ({
    mutate: mocks.decideMutate,
    isPending: false,
  }),
  useCancelOrchestratorTurn: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));

function makeDetail(): OrchestratorCaseDetail {
  return {
    id: CASE_ID,
    projectId: "p1",
    workflowId: "w1",
    title: "PROJ-7",
    sourceKey: null,
    status: OrchestratorCaseStatus.Open,
    conversationCount: 1,
    pendingDecisionCount: 1,
    activeTaskCount: 1,
    turnRunning: true,
    createdAt: "2026-10-26T08:00:00.000Z",
    updatedAt: "2026-10-26T08:10:00.000Z",
    notes: "",
    project: { id: "p1", name: "Web" },
    workflow: { id: "w1", name: "Orchestrated" },
    conversations: [
      {
        id: CONV,
        channelKey: "jira:PROJ-7",
        status: OrchestratorConversationStatus.Turn,
        createdAt: "2026-10-26T08:00:00.000Z",
        messages: [
          {
            id: "m1",
            conversationId: CONV,
            origin: OrchestratorMessageOrigin.External,
            kind: OrchestratorMessageKind.Message,
            actor: "Ann",
            text: "hello there",
            turnId: TURN,
            createdAt: "2026-10-26T08:00:00.000Z",
          },
        ],
        turns: [
          {
            id: TURN,
            conversationId: CONV,
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
        id: "task-1",
        conversationId: CONV,
        turnId: TURN,
        command: "/plan",
        args: "PROJ-7",
        prompt: "",
        mode: "plan",
        runnerName: null,
        computeTargetId: null,
        status: OrchestratorTaskStatus.Running,
        fork: false,
        resumeTaskId: null,
        loopId: LOOP_ID,
        reply: null,
        questions: [],
        error: null,
        waiting: null,
        createdAt: "2026-10-26T08:02:00.000Z",
        finishedAt: null,
      },
    ],
    waits: [],
    decisions: [
      {
        id: DECISION_ID,
        conversationId: CONV,
        question: "Approve?",
        status: OrchestratorDecisionStatus.Pending,
        via: null,
        decidedBy: null,
        comment: null,
        decidedAt: null,
        createdAt: "2026-10-26T08:06:00.000Z",
      },
    ],
  };
}

describe("OrchestratorCaseDetailView", () => {
  beforeEach(() => {
    mocks.query.data = makeDetail();
    mocks.query.isLoading = false;
    mocks.query.error = null;
    mocks.decideMutate.mockReset();
  });

  it("approves a pending decision", async () => {
    render(<OrchestratorCaseDetailView caseId={CASE_ID} isAdmin />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(mocks.decideMutate).toHaveBeenCalledWith({
      decisionId: DECISION_ID,
      input: { approved: true },
    });
  });

  it("hides admin actions for members", () => {
    render(<OrchestratorCaseDetailView caseId={CASE_ID} isAdmin={false} />);

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close case" })).toBeNull();
  });

  it("links a task to its loop", () => {
    render(<OrchestratorCaseDetailView caseId={CASE_ID} isAdmin />);

    expect(screen.getByRole("link", { name: "Open loop" })).toHaveAttribute(
      "href",
      `/acme/loops/${LOOP_ID}`
    );
  });

  it("shows a dash, not $0.00, when usage is unknown", () => {
    render(<OrchestratorCaseDetailView caseId={CASE_ID} isAdmin />);

    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
