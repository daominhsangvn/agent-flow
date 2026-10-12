import {
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import type { WorkflowComputeTargetChoices } from "@repo/app/workflows/lib/workflow-editor-options";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsTab } from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import { toComputeTargetOption } from "../use-workflow-compute-targets";
import {
  NewWorkflowView,
  WorkflowDetailPageView,
} from "../workflow-editor-views";

const TARGET_ID = "77777777-7777-4777-8777-777777777777";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const CONNECTIONS_PATH = `/settings?tab=${SettingsTab.Integrations}#integration-connections`;

const mocks = vi.hoisted(() => ({
  useComputeTargets: vi.fn(),
  editor: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: () => mocks.useComputeTargets(),
}));

vi.mock("@repo/app/workflows/components/workflow-editor", () => ({
  WorkflowEditor: (props: {
    computeTargets: WorkflowComputeTargetChoices;
    connectionsSettingsPath: string;
    isAdmin: boolean;
  }) => {
    mocks.editor(props);
    return <div data-testid="workflow-editor" />;
  },
}));

vi.mock("@repo/app/workflows/components/workflow-detail-view", () => ({
  WorkflowDetailView: (props: {
    computeTargets: WorkflowComputeTargetChoices;
    workflowId: string;
    isAdmin: boolean;
  }) => {
    mocks.detail(props);
    return <div data-testid="workflow-detail" />;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/workflows/new",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function makeTarget(overrides: Partial<ComputeTarget> = {}): ComputeTarget {
  return {
    id: TARGET_ID,
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Build Mac",
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: new Date(),
    isOnline: true,
    isSharedWithOrg: true,
    ownerName: "Ada",
    createdAt: new Date(),
    updatedAt: new Date(),
    selectedHarness: HarnessType.Claude,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useComputeTargets.mockReturnValue({
    data: [makeTarget()],
    isLoading: false,
    error: null,
  });
});

describe("toComputeTargetOption", () => {
  it("labels a target by machine and sharing, keeping its online state", () => {
    expect(toComputeTargetOption(makeTarget())).toEqual({
      id: TARGET_ID,
      label: "Build Mac",
      description: "Shared with the organization by Ada",
      isOnline: true,
    });
    expect(
      toComputeTargetOption(
        makeTarget({ isSharedWithOrg: false, isOnline: false })
      )
    ).toEqual({
      id: TARGET_ID,
      label: "Build Mac",
      description: "Ada",
      isOnline: false,
    });
  });
});

describe("NewWorkflowView", () => {
  it("hands admins the editor with compute targets and the connections link", () => {
    render(<NewWorkflowView isAdmin />);

    expect(screen.getByTestId("workflow-editor")).toBeInTheDocument();
    expect(mocks.editor).toHaveBeenCalledWith({
      computeTargets: {
        options: [toComputeTargetOption(makeTarget())],
        isLoading: false,
        error: null,
      },
      connectionsSettingsPath: CONNECTIONS_PATH,
      isAdmin: true,
    });
  });

  it("tells members only admins create workflows, without loading compute targets", () => {
    render(<NewWorkflowView isAdmin={false} />);

    expect(screen.getByText("Admins only")).toBeInTheDocument();
    expect(mocks.editor).not.toHaveBeenCalled();
    expect(mocks.useComputeTargets).not.toHaveBeenCalled();
  });
});

describe("WorkflowDetailPageView", () => {
  it("passes the workflow, the capability and the compute targets", () => {
    render(<WorkflowDetailPageView isAdmin={false} workflowId={WORKFLOW_ID} />);

    expect(mocks.detail).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: WORKFLOW_ID,
        isAdmin: false,
        connectionsSettingsPath: CONNECTIONS_PATH,
      })
    );
  });
});
