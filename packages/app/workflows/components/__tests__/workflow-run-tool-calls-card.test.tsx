import {
  IntegrationToolCallStatus,
  ToolCallDecision,
  type WorkflowRunToolCall,
} from "@repo/api/src/types/integration-tools";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_ID } from "../../__tests__/workflow-fixtures";
import { WorkflowRunToolCallsCard } from "../workflow-run-tool-calls-card";

const mocks = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../../hooks/use-workflows", () => ({
  useDecideWorkflowToolCall: () => ({ mutate: mocks.decide, isPending: false }),
}));

const PENDING: WorkflowRunToolCall = {
  id: "call-1",
  tool: "microsoft_teams_post_message",
  operationType: "microsoft_teams.post_message",
  connectionKey: "teams-release",
  input: { message: "Shipped JB-7." },
  status: IntegrationToolCallStatus.PendingApproval,
  externalRef: null,
  error: null,
  actionRunId: "ar-1",
  stepId: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date("2026-10-13T10:00:00.000Z"),
};

const REFUSED: WorkflowRunToolCall = {
  ...PENDING,
  id: "call-2",
  tool: "jira_create_issue",
  operationType: null,
  connectionKey: "jira-internal",
  input: {},
  status: IntegrationToolCallStatus.Refused,
  error: 'There is no tool "jira_create_issue" in this session.',
  actionRunId: null,
  stepId: "triage",
};

beforeEach(() => {
  vi.clearAllMocks();
});

function renderCard(isAdmin: boolean, toolCalls = [PENDING, REFUSED]) {
  render(
    <WorkflowRunToolCallsCard
      isAdmin={isAdmin}
      runId={RUN_ID}
      stepName={(stepId) => (stepId === "triage" ? "Triage" : stepId)}
      toolCalls={toolCalls}
    />
  );
  return screen.getAllByRole("row").slice(1);
}

describe("WorkflowRunToolCallsCard", () => {
  it("lists each call with its connection, agent, status and result", () => {
    const [pending, refused] = renderCard(false);

    expect(screen.getByText("1 write waits for approval.")).toBeInTheDocument();
    expect(pending).toHaveTextContent("microsoft_teams_post_message");
    expect(pending).toHaveTextContent("teams-release");
    expect(pending).toHaveTextContent("Instruction");
    expect(pending).toHaveTextContent("Waiting for approval");
    expect(pending).toHaveTextContent("message: Shipped JB-7.");
    expect(refused).toHaveTextContent("Step Triage");
    expect(refused).toHaveTextContent("Refused");
    expect(refused).toHaveTextContent(
      'There is no tool "jira_create_issue" in this session.'
    );
    expect(
      screen.queryByRole("button", { name: "Approve" })
    ).not.toBeInTheDocument();
  });

  it("lets an admin approve or reject a waiting call", async () => {
    const user = userEvent.setup();
    const [pending, refused] = renderCard(true);

    await user.click(
      within(pending as HTMLElement).getByRole("button", { name: "Approve" })
    );
    await user.click(
      within(pending as HTMLElement).getByRole("button", { name: "Reject" })
    );

    expect(mocks.decide).toHaveBeenNthCalledWith(1, {
      runId: RUN_ID,
      callId: "call-1",
      decision: ToolCallDecision.Approve,
    });
    expect(mocks.decide).toHaveBeenNthCalledWith(2, {
      runId: RUN_ID,
      callId: "call-1",
      decision: ToolCallDecision.Reject,
    });
    expect(
      within(refused as HTMLElement).queryByRole("button")
    ).not.toBeInTheDocument();
  });

  it("shows who decided", () => {
    const [row] = renderCard(false, [
      {
        ...PENDING,
        status: IntegrationToolCallStatus.Succeeded,
        externalRef: "msg-1",
        decidedBy: "Ada Admin",
        decidedAt: new Date("2026-10-13T10:05:00.000Z"),
      },
    ]);

    expect(row).toHaveTextContent("Approved by Ada Admin");
    expect(row).toHaveTextContent("Reference: msg-1");
  });

  it("renders nothing for a run without calls", () => {
    const { container } = render(
      <WorkflowRunToolCallsCard
        isAdmin
        runId={RUN_ID}
        stepName={(stepId) => stepId}
        toolCalls={[]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
