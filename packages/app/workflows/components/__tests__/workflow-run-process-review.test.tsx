import {
  ProcessStepType,
  ReviewDecisionKind,
  ReviewSignalVia,
  RunProcessSource,
  type RunProcessView,
} from "@repo/api/src/types/project-process";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunDetail, RUN_ID } from "../../__tests__/workflow-fixtures";
import { WorkflowRunProcessCard } from "../workflow-run-process-card";

/**
 * The review panel of a step under review:
 * how to decide on the ticket, earlier rounds, and Approve / Replan or
 * Done / Request changes, Reject in AgentFlow.
 */

const mocks = vi.hoisted(() => ({
  reviewMutateAsync: vi.fn(),
}));
vi.mock("../../hooks/use-workflows", async () => {
  const actual = await vi.importActual("../../hooks/use-workflows");
  return {
    ...actual,
    useDecideWorkflowRunReview: () => ({
      mutateAsync: mocks.reviewMutateAsync,
      isPending: false,
    }),
  };
});

function processView(
  review: Partial<NonNullable<RunProcessView["review"]>> = {}
): RunProcessView {
  return {
    version: 1,
    source: RunProcessSource.Workflow,
    toolkit: "acme/agent-repo",
    steps: [
      { id: "plan", name: "Plan", type: ProcessStepType.Agent },
      { id: "implement", name: "Implement", type: ProcessStepType.Agent },
    ],
    stepId: "plan",
    waiting: null,
    approval: null,
    review: {
      stepId: "plan",
      round: 2,
      planStep: true,
      waiting: true,
      requestedAt: "2026-10-15T09:00:00.000Z",
      goOnLabels: ["plan-approved"],
      feedbackLabels: ["replan"],
      mention: true,
      history: [
        {
          kind: ReviewDecisionKind.Feedback,
          via: ReviewSignalVia.Mention,
          text: "Split the export task",
          by: null,
          author: "Bea",
          label: null,
          at: "2026-10-15T08:00:00.000Z",
        },
      ],
      ...review,
    },
    stepFiles: [],
  };
}

function renderCard(process: RunProcessView, isAdmin = true) {
  return render(
    <WorkflowRunProcessCard
      isAdmin={isAdmin}
      run={makeRunDetail({ status: WorkflowRunStatus.NeedsApproval, process })}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reviewMutateAsync.mockResolvedValue(makeRunDetail());
});

describe("the review panel", () => {
  it("says how to decide on the ticket and lists the earlier rounds", () => {
    renderCard(processView());

    const panel = screen.getByTestId("run-step-review");
    expect(panel).toHaveTextContent('"Plan" waits for review (round 2)');
    expect(panel).toHaveTextContent(
      'On the ticket: add "plan-approved" to approve; add "replan" to ask for changes; mention the bot in a comment with the changes you want.'
    );
    expect(screen.getByTestId("run-step-review-history")).toHaveTextContent(
      "Changes asked · comment by Bea"
    );
  });

  it("lets an admin approve or replan a plan with a comment", async () => {
    const user = userEvent.setup();
    renderCard(processView());

    await user.type(screen.getByLabelText("Comment"), "More tests");
    await user.click(screen.getByRole("button", { name: "Replan" }));

    expect(mocks.reviewMutateAsync).toHaveBeenCalledWith({
      runId: RUN_ID,
      input: { decision: ReviewDecisionKind.Feedback, comment: "More tests" },
    });
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(mocks.reviewMutateAsync).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      input: { decision: ReviewDecisionKind.Approve, comment: "" },
    });
  });

  it("offers Done and Request changes on another step, only feedback to a member", () => {
    renderCard(processView({ planStep: false }), false);

    expect(
      screen.getByRole("button", { name: "Request changes" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("says the step works on the feedback while a round runs", () => {
    renderCard(processView({ waiting: false }));

    expect(screen.getByTestId("run-step-review")).toHaveTextContent(
      "The step is working on the latest feedback."
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
