import { OrgInviteRole } from "@repo/api/src/types/onboarding";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowDetailPage from "../[workflowId]/page";
import WorkflowRunPage from "../[workflowId]/runs/[runId]/page";
import NewWorkflowPage from "../new/page";
import WorkflowsPage from "../page";
import { resolveWorkflowAdmin } from "../workflow-admin";

const ORG_SLUG = "acme";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Better Auth carries the owner role in the same `org:` namespace. */
const ORG_OWNER_ROLE = "org:owner";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  header: vi.fn(),
  indexView: vi.fn(),
  newView: vi.fn(),
  detailView: vi.fn(),
  detailHeader: vi.fn(),
  runHeader: vi.fn(),
  runView: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));

vi.mock("../../../components/header", () => ({
  Header: (props: { breadcrumbs: { label: string; href?: string }[] }) => {
    mocks.header(props);
    return <div data-testid="header" />;
  },
}));

vi.mock("@repo/app/workflows/components/workflows-index-view", () => ({
  WorkflowsIndexView: (props: { isAdmin: boolean }) => {
    mocks.indexView(props);
    return <div data-testid="index-view" />;
  },
}));

vi.mock("@repo/app/workflows/components/workflow-run-detail-view", () => ({
  WorkflowRunDetailView: (props: { isAdmin: boolean; runId: string }) => {
    mocks.runView(props);
    return <div data-testid="run-view" />;
  },
}));

vi.mock("../components/workflow-editor-views", () => ({
  NewWorkflowView: (props: { isAdmin: boolean }) => {
    mocks.newView(props);
    return <div data-testid="new-view" />;
  },
  WorkflowDetailPageView: (props: { isAdmin: boolean; workflowId: string }) => {
    mocks.detailView(props);
    return <div data-testid="detail-view" />;
  },
}));

vi.mock("../components/workflow-headers", () => ({
  WorkflowDetailHeader: (props: { orgSlug: string; workflowId: string }) => {
    mocks.detailHeader(props);
    return <div data-testid="detail-header" />;
  },
  WorkflowRunHeader: (props: {
    orgSlug: string;
    workflowId: string;
    runId: string;
  }) => {
    mocks.runHeader(props);
    return <div data-testid="run-header" />;
  },
}));

function signInAs(orgRole: string | null) {
  mocks.auth.mockResolvedValue({ orgRole });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkflowAdmin", () => {
  it("grants org admins and owners, not members or a missing role", async () => {
    signInAs(OrgInviteRole.Admin);
    await expect(resolveWorkflowAdmin()).resolves.toBe(true);
    signInAs(ORG_OWNER_ROLE);
    await expect(resolveWorkflowAdmin()).resolves.toBe(true);
    signInAs(OrgInviteRole.Member);
    await expect(resolveWorkflowAdmin()).resolves.toBe(false);
    signInAs(null);
    await expect(resolveWorkflowAdmin()).resolves.toBe(false);
  });
});

describe("workflow routes", () => {
  it("renders the index with the Workflows breadcrumb and the admin capability", async () => {
    signInAs(OrgInviteRole.Admin);
    render(await WorkflowsPage());

    expect(screen.getByTestId("index-view")).toBeInTheDocument();
    expect(mocks.header).toHaveBeenCalledWith({
      breadcrumbs: [{ label: "Workflows" }],
    });
    expect(mocks.indexView).toHaveBeenCalledWith({ isAdmin: true });
  });

  it("passes the member capability to the new-workflow view", async () => {
    signInAs(OrgInviteRole.Member);
    render(
      await NewWorkflowPage({ params: Promise.resolve({ orgSlug: ORG_SLUG }) })
    );

    expect(mocks.newView).toHaveBeenCalledWith({ isAdmin: false });
    expect(mocks.header).toHaveBeenCalledWith({
      breadcrumbs: [
        { href: `/${ORG_SLUG}/workflows`, label: "Workflows" },
        { label: "New workflow" },
      ],
    });
  });

  it("renders the workflow detail for the route's workflow", async () => {
    signInAs(OrgInviteRole.Admin);
    render(
      await WorkflowDetailPage({
        params: Promise.resolve({ orgSlug: ORG_SLUG, workflowId: WORKFLOW_ID }),
      })
    );

    expect(mocks.detailHeader).toHaveBeenCalledWith({
      orgSlug: ORG_SLUG,
      workflowId: WORKFLOW_ID,
    });
    expect(mocks.detailView).toHaveBeenCalledWith({
      isAdmin: true,
      workflowId: WORKFLOW_ID,
    });
  });

  it("renders the run detail for the route's run", async () => {
    signInAs(OrgInviteRole.Member);
    render(
      await WorkflowRunPage({
        params: Promise.resolve({
          orgSlug: ORG_SLUG,
          workflowId: WORKFLOW_ID,
          runId: RUN_ID,
        }),
      })
    );

    expect(mocks.runHeader).toHaveBeenCalledWith({
      orgSlug: ORG_SLUG,
      workflowId: WORKFLOW_ID,
      runId: RUN_ID,
    });
    expect(mocks.runView).toHaveBeenCalledWith({
      isAdmin: false,
      runId: RUN_ID,
    });
  });
});
