import type {
  Workflow,
  WorkflowRunSummary,
} from "@repo/api/src/types/workflow";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../../integrations/__tests__/integration-fixtures";
import {
  makeRunSummary,
  makeWorkflow,
  RUN_ID,
  TRIGGER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { WorkflowDetailView } from "../workflow-detail-view";

type StartOptions = { onSuccess?: (run: WorkflowRunSummary) => void };

const mocks = vi.hoisted(() => ({
  workflow: undefined as Workflow | undefined,
  deleteMutateAsync: vi.fn(),
  startMutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../hooks/use-workflows", () => ({
  useWorkflow: () => ({
    data: mocks.workflow,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDeleteWorkflow: () => ({
    mutateAsync: mocks.deleteMutateAsync,
    isPending: false,
  }),
  useStartWorkflowRun: () => ({ mutate: mocks.startMutate, isPending: false }),
}));

// The editor and the run history have their own suites.
vi.mock("../workflow-editor", () => ({
  WorkflowEditor: ({ isAdmin }: { isAdmin: boolean }) => (
    <div data-testid="workflow-editor">{isAdmin ? "admin" : "member"}</div>
  ),
}));

vi.mock("../workflow-runs-table", () => ({
  WorkflowRunHistory: () => <div data-testid="run-history" />,
}));

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ data: PROVIDERS }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => `/acme/workflows/${WORKFLOW_ID}`,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mocks.navigate,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const COMPUTE_TARGETS = { options: [], isLoading: false, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workflow = makeWorkflow();
});

describe("WorkflowDetailView", () => {
  it("shows the workflow summary and its configuration", () => {
    render(
      <WorkflowDetailView
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflowId={WORKFLOW_ID}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Implement Jira requirements" })
    ).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-editor")).toHaveTextContent("admin");
  });

  it("starts a manual run from a trigger that supports it and opens the run", async () => {
    const user = userEvent.setup();
    mocks.startMutate.mockImplementation(
      (_variables: unknown, options: StartOptions) =>
        options.onSuccess?.(makeRunSummary())
    );
    render(
      <WorkflowDetailView
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflowId={WORKFLOW_ID}
      />
    );

    await user.click(screen.getByRole("button", { name: "Run now" }));
    const dialog = await screen.findByRole("dialog", { name: "Run now" });
    const input = within(dialog).getByLabelText("Issue key");
    expect(input).toHaveAttribute("placeholder", "PROJ-123");
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));
    expect(
      within(dialog).getByText("Enter the item to run on")
    ).toBeInTheDocument();
    expect(mocks.startMutate).not.toHaveBeenCalled();

    await user.type(input, " PROJ-7 ");
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));

    expect(mocks.startMutate).toHaveBeenCalledWith(
      {
        workflowId: WORKFLOW_ID,
        input: { triggerId: TRIGGER_ID, input: "PROJ-7" },
      },
      expect.any(Object)
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        `/acme/workflows/${WORKFLOW_ID}/runs/${RUN_ID}`
      )
    );
  });

  it("offers no manual run for a disabled workflow", () => {
    mocks.workflow = makeWorkflow({ enabled: false });
    render(
      <WorkflowDetailView
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflowId={WORKFLOW_ID}
      />
    );
    expect(
      screen.queryByRole("button", { name: "Run now" })
    ).not.toBeInTheDocument();
  });

  it("deletes the workflow after confirmation and returns to the list", async () => {
    const user = userEvent.setup();
    mocks.deleteMutateAsync.mockResolvedValue({ deleted: true });
    render(
      <WorkflowDetailView
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflowId={WORKFLOW_ID}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete workflow?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(mocks.deleteMutateAsync).toHaveBeenCalledWith(WORKFLOW_ID);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith("/acme/workflows")
    );
  });

  it("gives members the read-only configuration and no admin actions", () => {
    render(
      <WorkflowDetailView
        computeTargets={COMPUTE_TARGETS}
        isAdmin={false}
        workflowId={WORKFLOW_ID}
      />
    );

    expect(screen.getByTestId("workflow-editor")).toHaveTextContent("member");
    expect(
      screen.queryByRole("button", { name: "Run now" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
  });
});
