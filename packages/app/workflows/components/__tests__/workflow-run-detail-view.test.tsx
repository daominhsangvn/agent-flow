import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import { DocumentType } from "@repo/api/src/types/document";
import { ProcessDocumentType } from "@repo/api/src/types/project-process";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowInstructionOperationStatus,
  type WorkflowRunDetail,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunRetryMode,
  type WorkflowRunSession,
  WorkflowRunSourceClassificationOrigin,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_TRANSITION_ISSUE,
  PROVIDERS,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  ACTION_RUN_ID,
  ENDED_SESSION_ID,
  LIVE_SESSION_ID,
  LOOP_ID,
  makeRunDetail,
  PRE_ACTION_ID,
  PRE_ACTION_RUN_ID,
  RUN_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { WORKFLOW_RUN_ERROR_MESSAGES } from "../../lib/workflow-error-messages";
import {
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
} from "../../lib/workflow-labels";
import { WorkflowRunDetailView } from "../workflow-run-detail-view";

const PROJ_7_RE = /PROJ-7/;
const COMMENT_ON_THE_ISSUE_RE = /Comment on the issue/;
const TRANSITION_THE_ISSUE_RE = /Transition the issue/;
const SESSION_RUNNING_RE = /1 session is running/;

const mocks = vi.hoisted(() => ({
  run: {
    data: undefined as WorkflowRunDetail | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  cancelMutateAsync: vi.fn(),
  retryRunMutateAsync: vi.fn(),
  retryMutate: vi.fn(),
}));

vi.mock("../../hooks/use-workflows", async () => {
  const actual = await vi.importActual("../../hooks/use-workflows");
  return {
    ...actual,
    useWorkflowRun: () => mocks.run,
    useCancelWorkflowRun: () => ({
      mutateAsync: mocks.cancelMutateAsync,
      isPending: false,
    }),
    useRetryWorkflowRun: () => ({
      mutateAsync: mocks.retryRunMutateAsync,
      isPending: false,
    }),
    useRetryWorkflowActionRun: () => ({
      mutate: mocks.retryMutate,
      isPending: false,
    }),
  };
});

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ data: PROVIDERS }),
}));

// The loop badge reads the feature-flag port; its own tests cover it.
vi.mock("@repo/app/loops/components/loop-status-badge", () => ({
  LoopStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="loop-status">{status}</span>
  ),
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

/** Data rows of the actions table, in display order. */
function actionRows(): HTMLElement[] {
  const table = screen
    .getByRole("columnheader", { name: "Stage" })
    .closest("table");
  if (!(table instanceof HTMLElement)) {
    throw new Error("No actions table");
  }
  return within(table).getAllByRole("row").slice(1);
}

function failedPreActionRun(): WorkflowActionRun {
  return {
    id: PRE_ACTION_RUN_ID,
    actionId: PRE_ACTION_ID,
    actionType: JIRA_TRANSITION_ISSUE,
    stage: WorkflowActionStage.Pre,
    event: WorkflowRunEvent.Triggered,
    cycle: 2,
    status: WorkflowActionRunStatus.Failed,
    attempts: 5,
    lastError: "Transition In Progress not found",
    externalRef: null,
    instruction: null,
    completedAt: null,
    createdAt: new Date("2026-10-02T09:00:00.000Z"),
  };
}

function setRun(run: WorkflowRunDetail) {
  mocks.run.data = run;
  mocks.run.isLoading = false;
  mocks.run.error = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  setRun(makeRunDetail());
});

describe("WorkflowRunDetailView", () => {
  it("renders the source, status, workflow link and progress", () => {
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.getByRole("heading", { name: PROJ_7_RE })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Planning").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Implement Jira requirements" })
    ).toHaveAttribute("href", `/acme/workflows/${WORKFLOW_ID}`);
    const progress = screen.getByRole("list", { name: "Run progress" });
    expect(
      within(progress)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([
      "Received: done",
      "Importing: done",
      "Triggered actions: done",
      "Planning: in progress",
      "Implementing: not started",
      "Done: not started",
    ]);
  });

  it("lists the run's sessions and offers to watch the running one live", () => {
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const [liveRow, endedRow] = screen.getAllByTestId("run-session");
    expect(
      within(liveRow as HTMLElement).getByRole("link", {
        name: "SES-12 Plan PROJ-7",
      })
    ).toHaveAttribute("href", `/acme/sessions/${LIVE_SESSION_ID}`);
    expect(
      within(liveRow as HTMLElement).getByRole("link", { name: "Watch live" })
    ).toHaveAttribute("href", `/acme/sessions/${LIVE_SESSION_ID}`);
    expect(
      within(liveRow as HTMLElement).getByRole("link", { name: "Plan" })
    ).toHaveAttribute("href", `/acme/loops/${LOOP_ID}`);
    expect(
      within(endedRow as HTMLElement).getByRole("link", {
        name: "SES-11 Plan PROJ-7 (first attempt)",
      })
    ).toHaveAttribute("href", `/acme/sessions/${ENDED_SESSION_ID}`);
    expect(
      within(endedRow as HTMLElement).queryByRole("link", {
        name: "Watch live",
      })
    ).not.toBeInTheDocument();
    expect(screen.getByText(SESSION_RUNNING_RE)).toBeInTheDocument();
  });

  it("shows how long each session ran, a running one up to now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T09:14:30.000Z"));
    try {
      render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

      const [liveRow, endedRow] = screen.getAllByTestId("run-session");
      expect(
        within(liveRow as HTMLElement).getByTestId("run-session-duration")
      ).toHaveTextContent("12m 30s");
      expect(
        within(endedRow as HTMLElement).getByTestId("run-session-duration")
      ).toHaveTextContent("40s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a dash for a finished session without an end time", () => {
    const [, ended] = makeRunDetail().sessions;
    setRun(
      makeRunDetail({
        sessions: [{ ...(ended as WorkflowRunSession), endedAt: null }],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const [row] = screen.getAllByTestId("run-session");
    expect(
      within(row as HTMLElement).queryByTestId("run-session-duration")
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).getAllByRole("cell")[5]
    ).toHaveTextContent("-");
  });

  it("says when no session has synced yet", () => {
    setRun(makeRunDetail({ sessions: [] }));
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.getByText("No session has synced for this run yet.")
    ).toBeInTheDocument();
  });

  it("shows a run that is running its triggered actions, after the import", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.PreActions,
        loops: [],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.getByText(WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.PreActions])
    ).toBeInTheDocument();
    const progress = screen.getByRole("list", { name: "Run progress" });
    expect(
      within(progress).getByText("Triggered actions").closest("[data-state]")
    ).toHaveAttribute("data-state", "current");
    expect(
      within(progress).getByText("Importing").closest("[data-state]")
    ).toHaveAttribute("data-state", "done");
  });

  it("lists pre action runs first, with their stage and cycle", () => {
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const [preRow, postRow] = actionRows();
    expect(preRow).toHaveAccessibleName(TRANSITION_THE_ISSUE_RE);
    expect(
      within(preRow as HTMLElement).getByText("Before agents")
    ).toBeInTheDocument();
    expect(
      within(preRow as HTMLElement).getByText(
        WORKFLOW_RUN_EVENT_LABELS[WorkflowRunEvent.Triggered]
      )
    ).toBeInTheDocument();
    expect(postRow).toHaveAccessibleName(COMMENT_ON_THE_ISSUE_RE);
    expect(
      within(postRow as HTMLElement).getByText("After")
    ).toBeInTheDocument();
    expect(
      within(postRow as HTMLElement).getAllByRole("cell")[3]
    ).toHaveTextContent("1");
  });

  it("explains a run stopped by a failed pre action, without a retry for the pre action", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Failed,
        error: {
          code: WorkflowRunErrorCode.PreActionFailed,
          message:
            "Pre action Transition the issue failed: Transition In Progress not found",
        },
        feature: null,
        plan: null,
        loops: [],
        actionRuns: [failedPreActionRun()],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.getByText(
        WORKFLOW_RUN_ERROR_MESSAGES[WorkflowRunErrorCode.PreActionFailed]
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pre action Transition the issue failed: Transition In Progress not found"
      )
    ).toBeInTheDocument();
    const [preRow] = actionRows();
    expect(within(preRow as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(
      within(preRow as HTMLElement).queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
    const progress = screen.getByRole("list", { name: "Run progress" });
    expect(
      within(progress).getByText("Triggered actions").closest("[data-state]")
    ).toHaveAttribute("data-state", "failed");
  });

  it("links the source item, the imported Issue, the plan and the pull requests", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Succeeded,
        pullRequests: [
          {
            url: "https://github.com/acme/web/pull/12",
            number: 12,
            repository: "acme/web",
            branch: "feat/proj-7",
          },
          {
            url: "https://github.com/acme/api/pull/4",
            number: 4,
            repository: "acme/api",
            branch: "feat/proj-7-api",
          },
        ],
        branchName: "feat/proj-7",
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(screen.getByRole("link", { name: "Jira PROJ-7" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/browse/PROJ-7"
    );
    expect(
      screen.getByRole("link", { name: "ISS-42 PROJ-7: Add CSV export" })
    ).toHaveAttribute("href", "/acme/issues/ISS-42");
    expect(
      screen.getByRole("link", { name: "PLN-9 Plan: Add CSV export" })
    ).toHaveAttribute("href", "/acme/implementation-plans/PLN-9");
    const pullRequests = screen.getByTestId("run-pull-requests");
    expect(
      within(pullRequests).getByRole("link", { name: "acme/web #12" })
    ).toHaveAttribute("href", "https://github.com/acme/web/pull/12");
    expect(
      within(pullRequests).getByRole("link", { name: "acme/api #4" })
    ).toHaveAttribute("href", "https://github.com/acme/api/pull/4");
    expect(within(pullRequests).getByText("feat/proj-7")).toBeInTheDocument();
    expect(
      within(pullRequests).getByText("feat/proj-7-api")
    ).toBeInTheDocument();
  });

  it("labels and links a PRD the run imported from a product requirement", () => {
    setRun(
      makeRunDetail({
        feature: {
          id: "f-2",
          slug: "PRD-3",
          title: "CALC-1: Memory keys",
          type: DocumentType.Prd,
        },
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const source = screen.getByTestId("run-source-document");
    expect(
      within(source).getByRole("link", { name: "PRD-3 CALC-1: Memory keys" })
    ).toHaveAttribute("href", "/acme/prds/PRD-3");
    expect(screen.getByText("PRD", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText("Issue", { selector: "dt" })).toBeNull();
  });

  it("says why the PRD instruction made the item a PRD, or an Issue", () => {
    setRun(makeRunDetail());
    const { unmount } = render(
      <WorkflowRunDetailView isAdmin runId={RUN_ID} />
    );
    // Without an instruction there is nothing to explain.
    expect(screen.queryByTestId("run-source-classification")).toBeNull();
    unmount();

    setRun(
      makeRunDetail({
        sourceClassification: {
          type: DocumentType.Prd,
          origin: WorkflowRunSourceClassificationOrigin.Instruction,
          reason: "A Feature labelled PRD.",
        },
      })
    );
    const prd = render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);
    expect(screen.getByTestId("run-source-classification")).toHaveTextContent(
      "PRD instruction: A Feature labelled PRD."
    );
    prd.unmount();

    setRun(
      makeRunDetail({
        sourceClassification: {
          type: DocumentType.Feature,
          origin: WorkflowRunSourceClassificationOrigin.Fallback,
          reason: "The run's computer did not answer within 15 minutes.",
        },
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);
    expect(
      within(screen.getByTestId("run-source-document")).getByTestId(
        "run-source-classification"
      )
    ).toHaveTextContent(
      "The PRD instruction could not decide, so this is an Issue: The run's computer did not answer within 15 minutes."
    );
  });

  it("links the documents the process steps published", () => {
    setRun(
      makeRunDetail({
        documents: [
          {
            id: "prd-1",
            slug: "PRD-12",
            title: "PRD: Add CSV export",
            type: ProcessDocumentType.Prd,
            stepId: "prd",
          },
          {
            id: "doc-1",
            slug: "DOC-3",
            title: "Bug analysis: PROJ-7",
            type: ProcessDocumentType.Doc,
            stepId: "triage",
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const rows = screen.getAllByTestId("run-published-document");
    expect(rows).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "PRD-12 PRD: Add CSV export" })
    ).toHaveAttribute("href", "/acme/prds/PRD-12");
    expect(
      screen.getByRole("link", { name: "DOC-3 Bug analysis: PROJ-7" })
    ).toHaveAttribute("href", "/acme/documents/DOC-3");
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByText("Document")).toBeInTheDocument();
  });

  it("lists loops with their status and a link to the loop", () => {
    setRun(
      makeRunDetail({
        loops: [
          {
            loopId: LOOP_ID,
            command: LoopCommand.Execute,
            status: LoopStatus.Completed,
            adopted: true,
            stepId: null,
            prUrl: null,
            startedAt: null,
            completedAt: null,
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(screen.getByRole("link", { name: "Execute" })).toHaveAttribute(
      "href",
      `/acme/loops/${LOOP_ID}`
    );
    expect(screen.getByTestId("loop-status")).toHaveTextContent(
      LoopStatus.Completed
    );
    expect(screen.getByText("Adopted")).toBeInTheDocument();
  });

  it("shows action runs and lets admins retry a failed one", async () => {
    const user = userEvent.setup();
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const row = screen.getByRole("row", { name: COMMENT_ON_THE_ISSUE_RE });
    expect(within(row).getByText("Run started")).toBeInTheDocument();
    expect(within(row).getByText("Failed")).toBeInTheDocument();
    expect(within(row).getByText("5")).toBeInTheDocument();
    expect(within(row).getByText("Jira returned 403")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Retry" }));
    expect(mocks.retryMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      actionRunId: ACTION_RUN_ID,
    });
  });

  it("lets admins retry a skipped post action once its cause is fixed, never a skipped pre action", async () => {
    const user = userEvent.setup();
    const [postRun] = makeRunDetail().actionRuns;
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Succeeded,
        actionRuns: [
          {
            ...(postRun as WorkflowActionRun),
            status: WorkflowActionRunStatus.Skipped,
            lastError: "The connection is disabled",
          },
          {
            ...failedPreActionRun(),
            status: WorkflowActionRunStatus.Skipped,
            lastError: "The connection is disabled",
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const [preRow, postRow] = actionRows();
    expect(
      within(preRow as HTMLElement).queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
    await user.click(
      within(postRow as HTMLElement).getByRole("button", { name: "Retry" })
    );
    expect(mocks.retryMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      actionRunId: ACTION_RUN_ID,
    });
  });

  it("offers no retry for a post action that is pending or delivered", () => {
    const [postRun] = makeRunDetail().actionRuns;
    setRun(
      makeRunDetail({
        actionRuns: [
          {
            ...(postRun as WorkflowActionRun),
            status: WorkflowActionRunStatus.Pending,
          },
          {
            ...(postRun as WorkflowActionRun),
            id: "77777777-7777-4777-8777-777777777777",
            status: WorkflowActionRunStatus.Succeeded,
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("shows a delivered action's external reference as a link", () => {
    setRun(
      makeRunDetail({
        actionRuns: [
          {
            id: ACTION_RUN_ID,
            actionId: null,
            actionType: JIRA_ADD_COMMENT,
            stage: WorkflowActionStage.Post,
            event: WorkflowRunEvent.Succeeded,
            cycle: 1,
            status: WorkflowActionRunStatus.Succeeded,
            attempts: 1,
            lastError: null,
            externalRef: "https://acme.atlassian.net/browse/PROJ-7#comment-1",
            instruction: null,
            completedAt: new Date(),
            createdAt: new Date(),
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/browse/PROJ-7#comment-1"
    );
    expect(screen.getByText("(removed)")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("shows what an instruction's agent did: its note, each operation and its cost", () => {
    setRun(
      makeRunDetail({
        actionRuns: [
          {
            id: ACTION_RUN_ID,
            actionId: "instruction-1",
            actionType: WORKFLOW_INSTRUCTION_ACTION_TYPE,
            stage: WorkflowActionStage.Post,
            event: WorkflowRunEvent.ExecuteCompleted,
            cycle: 1,
            status: WorkflowActionRunStatus.Failed,
            attempts: 1,
            lastError: "source_item_comment failed: HTTP 503",
            externalRef: null,
            instruction: {
              note: "Moved the issue and summarized the change.",
              operations: [
                {
                  type: JIRA_TRANSITION_ISSUE,
                  config: { transition: "In Review" },
                  status: WorkflowInstructionOperationStatus.Succeeded,
                  externalRef: null,
                  error: null,
                },
                {
                  type: JIRA_ADD_COMMENT,
                  connection: "jira-shop",
                  config: { body: "Summary" },
                  status: WorkflowInstructionOperationStatus.Failed,
                  externalRef: null,
                  error: "HTTP 503",
                },
              ],
              costUsd: null,
              inputTokens: 1200,
              outputTokens: 80,
            },
            completedAt: new Date(),
            createdAt: new Date(),
          },
        ],
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    const [row] = actionRows();
    expect(
      within(row as HTMLElement).getByText("Instruction")
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(
        "Moved the issue and summarized the change."
      )
    ).toBeInTheDocument();
    expect(row).toHaveTextContent(`${JIRA_TRANSITION_ISSUE} done`);
    expect(row).toHaveTextContent(
      `${JIRA_ADD_COMMENT} on jira-shop failed: HTTP 503`
    );
    // An unknown cost is never shown as $0.00.
    expect(row).toHaveTextContent("1.20k in · 80 out · cost unknown");
  });

  it("cancels an active run after confirmation", async () => {
    const user = userEvent.setup();
    mocks.cancelMutateAsync.mockResolvedValue(makeRunDetail());
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Cancel this run?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Cancel run" })
    );
    expect(mocks.cancelMutateAsync).toHaveBeenCalledWith(RUN_ID);
  });

  it("retries the failed step in its session, or restarts it, after confirmation", async () => {
    const user = userEvent.setup();
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Failed,
        error: {
          code: WorkflowRunErrorCode.ExecuteFailed,
          message: "401 OAuth access token has expired.",
        },
        retryStep: { id: "implement", name: "Implement", resumable: true },
      })
    );
    mocks.retryRunMutateAsync.mockResolvedValue(makeRunDetail());
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    await user.click(screen.getByRole("button", { name: "Retry Implement" }));
    const retryDialog = await screen.findByRole("dialog", {
      name: "Retry the failed step?",
    });
    await user.click(
      within(retryDialog).getByRole("button", { name: "Retry Implement" })
    );
    expect(mocks.retryRunMutateAsync).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      mode: WorkflowRunRetryMode.Resume,
    });

    await user.click(screen.getByRole("button", { name: "Restart Implement" }));
    const restartDialog = await screen.findByRole("dialog", {
      name: "Restart the failed step?",
    });
    await user.click(
      within(restartDialog).getByRole("button", { name: "Restart Implement" })
    );
    expect(mocks.retryRunMutateAsync).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      mode: WorkflowRunRetryMode.Restart,
    });
  });

  it("offers only a restart when the step's session cannot be resumed", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Failed,
        retryStep: { id: "implement", name: "Implement", resumable: false },
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.getByRole("button", { name: "Restart Implement" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry Implement" })
    ).not.toBeInTheDocument();
  });

  it("offers no step retry without a retryable step or to members", () => {
    const failed = makeRunDetail({
      status: WorkflowRunStatus.Failed,
      retryStep: { id: "implement", name: "Implement", resumable: true },
    });
    setRun(failed);
    const { unmount } = render(
      <WorkflowRunDetailView isAdmin={false} runId={RUN_ID} />
    );
    expect(
      screen.queryByRole("button", { name: "Retry Implement" })
    ).not.toBeInTheDocument();
    unmount();

    setRun({ ...failed, retryStep: null });
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);
    // Action runs keep their own "Retry"; the step retry names its step.
    expect(
      screen.queryByRole("button", { name: "Retry Implement" })
    ).not.toBeInTheDocument();
  });

  it("offers no cancel or retry to members, and no cancel for a final run", () => {
    render(<WorkflowRunDetailView isAdmin={false} runId={RUN_ID} />);
    expect(
      screen.queryByRole("button", { name: "Cancel run" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("hides cancel once the run is final and shows its error", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Failed,
        error: {
          code: WorkflowRunErrorCode.ComputeTargetUnavailable,
          message: "Target offline",
        },
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(
      screen.queryByRole("button", { name: "Cancel run" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        WORKFLOW_RUN_ERROR_MESSAGES[
          WorkflowRunErrorCode.ComputeTargetUnavailable
        ]
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Target offline")).toBeInTheDocument();
    expect(
      screen.getByText(WorkflowRunErrorCode.ComputeTargetUnavailable)
    ).toBeInTheDocument();
  });

  it("falls back to the raw code of an unknown error", () => {
    setRun(
      makeRunDetail({
        status: WorkflowRunStatus.Failed,
        error: { code: "future_code", message: "Something new" },
      })
    );
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);

    expect(screen.getByText("future_code")).toBeInTheDocument();
    expect(screen.getByText("Something new")).toBeInTheDocument();
  });

  it("shows not found for a missing run and an inline error otherwise", () => {
    mocks.run.data = undefined;
    mocks.run.error = new ApiError("Not found", 404);
    const { unmount } = render(
      <WorkflowRunDetailView isAdmin runId={RUN_ID} />
    );
    expect(screen.getByText("Run not found")).toBeInTheDocument();
    unmount();

    mocks.run.error = new ApiError("Server exploded", 500);
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);
    expect(screen.getByText("Couldn't load the run")).toBeInTheDocument();
    expect(screen.getByText("Server exploded")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    mocks.run.data = undefined;
    mocks.run.isLoading = true;
    render(<WorkflowRunDetailView isAdmin runId={RUN_ID} />);
    expect(
      screen.getByRole("status", { name: "Loading run" })
    ).toBeInTheDocument();
  });
});
