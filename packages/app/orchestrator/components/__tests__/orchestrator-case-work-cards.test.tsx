import type {
  OrchestratorCaseDetail,
  OrchestratorCaseLoops,
} from "@repo/api/src/types/orchestrator";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorCaseWorkCards } from "../orchestrator-case-work-cards";

const mocks = vi.hoisted(() => ({
  loops: {
    data: undefined as OrchestratorCaseLoops | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  useLoops: vi.fn(),
  active: false,
}));

vi.mock("../../hooks/use-orchestrator-cases", () => ({
  useOrchestratorCaseLoops: (...args: unknown[]) => {
    mocks.useLoops(...args);
    return mocks.loops;
  },
  isCaseActive: () => mocks.active,
}));

vi.mock("@repo/app/workflows/components/workflow-run-sessions-card", () => ({
  WorkflowRunSessionsCard: ({
    sessions,
    emptyText,
  }: {
    sessions: unknown[];
    emptyText: string;
  }) => (
    <div data-testid="sessions">
      {sessions.length === 0 ? emptyText : `${sessions.length} sessions`}
    </div>
  ),
}));

vi.mock("@repo/app/loops/components/loop-status-badge", () => ({
  LoopStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const detail = {
  id: "case-1",
  sourceKey: "jira:PROJ-7",
} as OrchestratorCaseDetail;

function loopsData(): OrchestratorCaseLoops {
  return {
    loops: [
      {
        loopId: "loop-1",
        command: "custom-cmd",
        status: "COMPLETED",
        adopted: false,
        stepId: null,
        prUrl: null,
        startedAt: new Date("2026-10-26T08:00:00.000Z"),
        completedAt: null,
      },
    ],
    sessions: [],
    pullRequests: [
      {
        url: "https://example.test/pr/1",
        number: 1,
        repository: "acme/web",
        branch: "b",
      },
    ],
  };
}

describe("OrchestratorCaseWorkCards", () => {
  beforeEach(() => {
    mocks.loops.data = loopsData();
    mocks.loops.isLoading = false;
    mocks.loops.error = null;
    mocks.active = false;
    mocks.useLoops.mockReset();
  });

  it("links a loop and shows the raw task command", () => {
    render(<OrchestratorCaseWorkCards detail={detail} />);

    expect(screen.getByRole("link", { name: "custom-cmd" })).toHaveAttribute(
      "href",
      "/acme/loops/loop-1"
    );
  });

  it("lists the pull request under Work items", () => {
    render(<OrchestratorCaseWorkCards detail={detail} />);

    expect(
      screen.getByTestId("case-pull-requests").querySelector("a")
    ).toHaveAttribute("href", "https://example.test/pr/1");
    expect(screen.getByText("jira:PROJ-7")).toBeInTheDocument();
  });

  it("shows the empty texts", () => {
    mocks.loops.data = { loops: [], sessions: [], pullRequests: [] };
    render(<OrchestratorCaseWorkCards detail={detail} />);

    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(
      screen.getByText("No task has launched a loop yet.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No session has synced for this case yet.")
    ).toBeInTheDocument();
  });

  it("polls only while the case is active", () => {
    render(<OrchestratorCaseWorkCards detail={detail} />);
    expect(mocks.useLoops).toHaveBeenLastCalledWith("case-1", { poll: false });

    mocks.active = true;
    render(<OrchestratorCaseWorkCards detail={detail} />);
    expect(mocks.useLoops).toHaveBeenLastCalledWith("case-1", { poll: true });
  });
});
