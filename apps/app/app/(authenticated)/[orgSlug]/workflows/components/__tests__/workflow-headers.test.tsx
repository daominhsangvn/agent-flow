import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDetailHeader, WorkflowRunHeader } from "../workflow-headers";

const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  header: vi.fn(),
  useWorkflow: vi.fn(),
  useWorkflowRun: vi.fn(),
  useDocumentTitle: vi.fn(),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: (props: unknown) => {
    mocks.header(props);
    return null;
  },
}));

vi.mock("@repo/app/workflows/hooks/use-workflows", () => ({
  useWorkflow: (id: string) => mocks.useWorkflow(id),
  useWorkflowRun: (id: string) => mocks.useWorkflowRun(id),
}));

vi.mock("@repo/app/shared/hooks/use-document-title", () => ({
  useDocumentTitle: (title: string | null) => mocks.useDocumentTitle(title),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowDetailHeader", () => {
  it("names the workflow once it loads, and the generic kind before", () => {
    mocks.useWorkflow.mockReturnValue({ data: undefined });
    const { rerender } = render(
      <WorkflowDetailHeader orgSlug="acme" workflowId={WORKFLOW_ID} />
    );
    expect(mocks.header).toHaveBeenLastCalledWith({
      breadcrumbs: [
        { href: "/acme/workflows", label: "Workflows" },
        { label: "Workflow" },
      ],
    });

    mocks.useWorkflow.mockReturnValue({ data: { name: "Jira to PR" } });
    rerender(<WorkflowDetailHeader orgSlug="acme" workflowId={WORKFLOW_ID} />);
    expect(mocks.header).toHaveBeenLastCalledWith({
      breadcrumbs: [
        { href: "/acme/workflows", label: "Workflows" },
        { label: "Jira to PR" },
      ],
    });
    expect(mocks.useDocumentTitle).toHaveBeenLastCalledWith("Jira to PR");
    expect(mocks.useWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
  });
});

describe("WorkflowRunHeader", () => {
  it("links back to the workflow and names the run by its source item", () => {
    mocks.useWorkflowRun.mockReturnValue({
      data: { workflowName: "Jira to PR", source: { key: "PROJ-7" } },
    });
    render(
      <WorkflowRunHeader
        orgSlug="acme"
        runId={RUN_ID}
        workflowId={WORKFLOW_ID}
      />
    );

    expect(mocks.header).toHaveBeenLastCalledWith({
      breadcrumbs: [
        { href: "/acme/workflows", label: "Workflows" },
        { href: `/acme/workflows/${WORKFLOW_ID}`, label: "Jira to PR" },
        { label: "PROJ-7" },
      ],
    });
    expect(mocks.useWorkflowRun).toHaveBeenCalledWith(RUN_ID);
  });
});
