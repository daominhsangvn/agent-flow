import {
  ProcessStepType,
  RunProcessSource,
  type RunProcessView,
} from "@repo/api/src/types/project-process";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunDetail, RUN_ID } from "../../__tests__/workflow-fixtures";
import { WorkflowRunProcessCard } from "../workflow-run-process-card";

const mocks = vi.hoisted(() => ({
  answerMutateAsync: vi.fn(),
  decideMutateAsync: vi.fn(),
}));

vi.mock("../../hooks/use-workflows", async () => {
  const actual = await vi.importActual("../../hooks/use-workflows");
  return {
    ...actual,
    useAnswerWorkflowRunQuestions: () => ({
      mutateAsync: mocks.answerMutateAsync,
      isPending: false,
    }),
    useDecideWorkflowRunApproval: () => ({
      mutateAsync: mocks.decideMutateAsync,
      isPending: false,
    }),
  };
});

const STEPS: RunProcessView["steps"] = [
  { id: "specify", name: "Specify", type: ProcessStepType.Agent },
  { id: "clarify", name: "Clarify", type: ProcessStepType.Agent },
  { id: "review", name: "Review the spec", type: ProcessStepType.Approval },
  { id: "implement", name: "Implement", type: ProcessStepType.Agent },
];

const SPEC_FILE = {
  path: "specs/001/spec.md",
  content: "# Color picker spec",
  truncated: false,
};

function processView(overrides: Partial<RunProcessView> = {}): RunProcessView {
  return {
    version: 2,
    source: RunProcessSource.Project,
    toolkit: "acme/toolkit",
    steps: STEPS,
    stepId: "clarify",
    waiting: null,
    approval: null,
    review: null,
    stepFiles: [],
    ...overrides,
  };
}

function renderCard(
  status: WorkflowRunStatus,
  process: RunProcessView | null,
  isAdmin = true
) {
  return render(
    <WorkflowRunProcessCard
      isAdmin={isAdmin}
      run={makeRunDetail({ status, process })}
    />
  );
}

function stepProgress(): Array<string | null> {
  return screen
    .getAllByTestId("process-run-step")
    .map((row) => row.getAttribute("data-progress"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.answerMutateAsync.mockResolvedValue(makeRunDetail());
  mocks.decideMutateAsync.mockResolvedValue(makeRunDetail());
});

describe("WorkflowRunProcessCard", () => {
  it("renders nothing for a run on the built-in flow", () => {
    const { container } = renderCard(WorkflowRunStatus.Planning, null);

    expect(container).toBeEmptyDOMElement();
  });

  it("names the process the run follows: a project version or the workflow's own", () => {
    const { unmount } = renderCard(WorkflowRunStatus.Running, processView());
    expect(screen.getByTestId("workflow-run-process")).toHaveTextContent(
      "Version 2"
    );
    unmount();

    renderCard(
      WorkflowRunStatus.Running,
      processView({ source: RunProcessSource.Workflow, version: 1 })
    );
    expect(screen.getByTestId("workflow-run-process")).toHaveTextContent(
      "The workflow's own process"
    );
  });

  it("shows the steps with where the run is", () => {
    renderCard(WorkflowRunStatus.Running, processView());

    expect(screen.getByText("Version 2 · toolkit acme/toolkit")).toBeVisible();
    expect(stepProgress()).toEqual(["done", "current", "upcoming", "upcoming"]);
  });

  it("marks the step a failed run stopped at, and every step of a run that succeeded", () => {
    const { unmount } = renderCard(
      WorkflowRunStatus.Failed,
      processView({ stepId: "review" })
    );
    expect(stepProgress()).toEqual(["done", "done", "stopped", "upcoming"]);
    unmount();

    renderCard(
      WorkflowRunStatus.Succeeded,
      processView({ stepId: "implement" })
    );
    expect(stepProgress()).toEqual(["done", "done", "done", "done"]);
  });

  it("sends the answers given, picking an option or typing", async () => {
    const user = userEvent.setup();
    renderCard(
      WorkflowRunStatus.NeedsInput,
      processView({
        waiting: {
          stepId: "clarify",
          questions: [
            { id: "q1", question: "Hex or RGB?", options: ["Hex", "RGB"] },
            { id: "q2", question: "Keep a history?" },
            { id: "q3", question: "Dark theme?" },
          ],
          askedAt: "2026-10-01T09:00:00.000Z",
          answered: false,
        },
      })
    );
    const form = screen.getByTestId("run-step-questions");
    const send = within(form).getByRole("button", { name: "Send answers" });
    expect(send).toBeDisabled();

    const rgb = within(form).getByRole("button", { name: "RGB" });
    expect(rgb).toHaveAttribute("aria-pressed", "false");
    await user.click(rgb);
    expect(rgb).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("button", { name: "Hex" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await user.type(
      within(form).getByLabelText("Keep a history?"),
      "Yes, the last 10"
    );
    await user.click(send);

    expect(mocks.answerMutateAsync).toHaveBeenCalledWith({
      runId: RUN_ID,
      input: {
        answers: [
          { id: "q1", answer: "RGB" },
          { id: "q2", answer: "Yes, the last 10" },
        ],
      },
    });
  });

  it("says the answers were sent once the step goes on with them", () => {
    renderCard(
      WorkflowRunStatus.NeedsInput,
      processView({
        waiting: {
          stepId: "clarify",
          questions: [{ id: "q1", question: "Hex or RGB?" }],
          askedAt: "2026-10-01T09:00:00.000Z",
          answered: true,
        },
      })
    );

    expect(screen.queryByTestId("run-step-questions")).not.toBeInTheDocument();
    expect(screen.getByText('Answers sent to "Clarify"')).toBeVisible();
  });

  it("shows the files to review and lets an admin approve or reject with a comment", async () => {
    const user = userEvent.setup();
    renderCard(
      WorkflowRunStatus.NeedsApproval,
      processView({
        stepId: "review",
        approval: {
          stepId: "review",
          requestedAt: "2026-10-01T09:00:00.000Z",
          show: ["specify"],
          decided: false,
        },
        stepFiles: [
          { stepId: "specify", loopId: "loop-1", files: [SPEC_FILE] },
        ],
      })
    );
    const panel = screen.getByTestId("run-step-approval");
    expect(within(panel).getByText("specs/001/spec.md")).toBeVisible();
    expect(
      within(panel).getByRole("heading", { name: "Color picker spec" })
    ).toBeVisible();

    await user.type(within(panel).getByLabelText("Comment"), "Needs alpha");
    await user.click(within(panel).getByRole("button", { name: "Reject" }));

    expect(mocks.decideMutateAsync).toHaveBeenCalledWith({
      runId: RUN_ID,
      input: { approved: false, comment: "Needs alpha" },
    });

    await user.click(within(panel).getByRole("button", { name: "Approve" }));
    expect(mocks.decideMutateAsync).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      input: { approved: true, comment: "Needs alpha" },
    });
  });

  it("does not let a member decide an approval", () => {
    renderCard(
      WorkflowRunStatus.NeedsApproval,
      processView({
        stepId: "review",
        approval: {
          stepId: "review",
          requestedAt: "2026-10-01T09:00:00.000Z",
          show: [],
          decided: false,
        },
      }),
      false
    );
    const panel = screen.getByTestId("run-step-approval");

    expect(
      within(panel).queryByRole("button", { name: "Approve" })
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByText("An org admin approves or rejects this step.")
    ).toBeVisible();
  });

  it("lists the files of each step", () => {
    renderCard(
      WorkflowRunStatus.Running,
      processView({
        stepFiles: [
          { stepId: "specify", loopId: "loop-1", files: [SPEC_FILE] },
        ],
      })
    );
    const files = screen.getByTestId("run-step-files");

    expect(within(files).getByText("Specify")).toBeVisible();
    expect(within(files).getByText("specs/001/spec.md")).toBeVisible();
  });
});
