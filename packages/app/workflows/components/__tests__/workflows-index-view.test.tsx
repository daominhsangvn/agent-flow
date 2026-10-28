import {
  type Workflow,
  WorkflowRunErrorCode,
  WorkflowRunStatus,
  type WorkflowRunSummary,
} from "@repo/api/src/types/workflow";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../../integrations/__tests__/integration-fixtures";
import {
  makeRunSummary,
  makeWorkflow,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { WORKFLOW_RUN_ERROR_MESSAGES } from "../../lib/workflow-error-messages";
import {
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_SOURCE_SYSTEMS_NOTICE,
} from "../../lib/workflow-labels";
import { WorkflowsIndexView } from "../workflows-index-view";

const PRE_ACTION_ERROR_MESSAGE =
  "Pre action Transition the issue failed: Jira returned 403";

const mocks = vi.hoisted(() => ({
  workflows: {
    data: undefined as Workflow[] | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  setEnabledMutate: vi.fn(),
  updateMutate: vi.fn(),
  fetchNextPage: vi.fn(),
  runs: [] as WorkflowRunSummary[],
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("../../hooks/use-workflows", async () => {
  const actual = await vi.importActual("../../hooks/use-workflows");
  return {
    ...actual,
    useWorkflows: () => mocks.workflows,
    useSetWorkflowEnabled: () => ({
      mutate: mocks.setEnabledMutate,
      isPending: false,
      error: null,
    }),
    useUpdateWorkflow: () => ({
      mutate: mocks.updateMutate,
      isPending: false,
    }),
    useOrgWorkflowRuns: () => ({
      data: {
        pages: [{ runs: mocks.runs, nextCursor: "next" }],
        pageParams: [null],
      },
      isLoading: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ data: PROVIDERS }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/workflows",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => mocks.searchParams,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    replace: mocks.replace,
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchParams = new URLSearchParams();
  mocks.workflows.data = [makeWorkflow()];
  mocks.workflows.isLoading = false;
  mocks.workflows.error = null;
  mocks.runs = [makeRunSummary()];
});

describe("WorkflowsIndexView", () => {
  it("lists workflows with triggers, project, run counts and a link", () => {
    render(<WorkflowsIndexView isAdmin />);

    expect(
      screen.getByRole("link", { name: "Implement Jira requirements" })
    ).toHaveAttribute("href", `/acme/workflows/${WORKFLOW_ID}`);
    expect(screen.getByText("Issue assigned to the bot")).toBeInTheDocument();
    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("2 succeeded")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New workflow" })).toHaveAttribute(
      "href",
      "/acme/workflows/new"
    );
    expect(
      screen.getByText(WORKFLOW_SOURCE_SYSTEMS_NOTICE)
    ).toBeInTheDocument();
  });

  it("shows case counts for an orchestrated workflow", () => {
    mocks.workflows.data = [
      makeWorkflow({
        caseCounts: { total: 3, open: 1, closed: 2, lastActivityAt: null },
      }),
    ];
    render(<WorkflowsIndexView isAdmin />);

    expect(screen.getByText("3 cases")).toBeInTheDocument();
    expect(screen.getByText("1 open")).toBeInTheDocument();
  });

  it("lets admins disable a workflow by flipping only its enabled flag", async () => {
    const user = userEvent.setup();
    render(<WorkflowsIndexView isAdmin />);

    await user.click(
      screen.getByRole("switch", {
        name: "Disable Implement Jira requirements",
      })
    );
    expect(mocks.setEnabledMutate).toHaveBeenCalledWith({
      id: WORKFLOW_ID,
      input: { enabled: false },
    });
    expect(mocks.updateMutate).not.toHaveBeenCalled();
  });

  it("can still turn off a workflow whose project is gone, but not turn it on", async () => {
    const user = userEvent.setup();
    mocks.workflows.data = [
      makeWorkflow({ project: null }),
      makeWorkflow({
        id: "66666666-6666-4666-8666-666666666666",
        name: "Paused workflow",
        enabled: false,
        project: null,
      }),
    ];
    render(<WorkflowsIndexView isAdmin />);

    expect(
      screen.getByRole("switch", { name: "Enable Paused workflow" })
    ).toBeDisabled();
    await user.click(
      screen.getByRole("switch", {
        name: "Disable Implement Jira requirements",
      })
    );
    expect(mocks.setEnabledMutate).toHaveBeenCalledWith({
      id: WORKFLOW_ID,
      input: { enabled: false },
    });
  });

  it("shows members a read-only list without the create action", () => {
    render(<WorkflowsIndexView isAdmin={false} />);

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "New workflow" })
    ).not.toBeInTheDocument();
  });

  it("shows the empty state and the error state", () => {
    mocks.workflows.data = [];
    const { unmount } = render(<WorkflowsIndexView isAdmin />);
    expect(screen.getByText("No workflows yet")).toBeInTheDocument();
    unmount();

    mocks.workflows.data = undefined;
    mocks.workflows.error = new Error("down");
    render(<WorkflowsIndexView isAdmin />);
    expect(screen.getByText("Couldn't load workflows")).toBeInTheDocument();
  });

  it("switches to the org-wide runs tab through the URL", async () => {
    const user = userEvent.setup();
    render(<WorkflowsIndexView isAdmin />);

    await user.click(screen.getByRole("tab", { name: "Runs" }));
    expect(mocks.replace).toHaveBeenCalledWith("/acme/workflows?tab=runs", {
      scroll: false,
    });
  });

  it("renders the org-wide run history with paging when deep-linked", async () => {
    const user = userEvent.setup();
    mocks.searchParams = new URLSearchParams("tab=runs");
    render(<WorkflowsIndexView isAdmin />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("PROJ-7")).toBeInTheDocument();
    expect(
      within(table).getByRole("link", { name: "Implement Jira requirements" })
    ).toHaveAttribute("href", `/acme/workflows/${WORKFLOW_ID}`);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("shows pre action progress and readable failure reasons in the run history", () => {
    mocks.searchParams = new URLSearchParams("tab=runs");
    mocks.runs = [
      makeRunSummary({ id: "run-1", status: WorkflowRunStatus.PreActions }),
      makeRunSummary({
        id: "run-2",
        status: WorkflowRunStatus.Failed,
        error: {
          code: WorkflowRunErrorCode.PreActionFailed,
          message: PRE_ACTION_ERROR_MESSAGE,
        },
      }),
    ];
    render(<WorkflowsIndexView isAdmin />);

    const table = screen.getByRole("table");
    expect(
      within(table).getByText(
        WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.PreActions]
      )
    ).toBeInTheDocument();
    const reason = within(table).getByText(
      WORKFLOW_RUN_ERROR_MESSAGES[WorkflowRunErrorCode.PreActionFailed]
    );
    expect(reason).toHaveAttribute("title", PRE_ACTION_ERROR_MESSAGE);
    expect(reason).toHaveTextContent(PRE_ACTION_ERROR_MESSAGE);
  });

  it("lists the pull request of every repository a run changed", () => {
    mocks.searchParams = new URLSearchParams("tab=runs");
    mocks.runs = [
      makeRunSummary({
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
            branch: "feat/proj-7",
          },
        ],
      }),
    ];
    render(<WorkflowsIndexView isAdmin />);

    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Pull requests" })
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("link", { name: "web #12" })
    ).toHaveAttribute("href", "https://github.com/acme/web/pull/12");
    expect(within(table).getByRole("link", { name: "api #4" })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/pull/4"
    );
  });
});
