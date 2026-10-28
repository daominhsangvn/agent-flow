import {
  OrchestratorCaseStatus,
  type OrchestratorCaseSummary,
} from "@repo/api/src/types/orchestrator";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorCaseList } from "../orchestrator-case-list";

const mocks = vi.hoisted(() => ({
  cases: {
    data: undefined as OrchestratorCaseSummary[] | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("../../hooks/use-orchestrator-cases", () => ({
  useWorkflowOrchestratorCases: () => mocks.cases,
  isCaseActive: (c: { turnRunning: boolean; activeTaskCount: number }) =>
    c.turnRunning || c.activeTaskCount > 0,
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

function summary(
  overrides: Partial<OrchestratorCaseSummary>
): OrchestratorCaseSummary {
  return {
    id: "case-1",
    projectId: "p1",
    workflowId: "w1",
    title: "PROJ-7 login bug",
    sourceKey: "jira:PROJ-7",
    status: OrchestratorCaseStatus.Open,
    conversationCount: 1,
    pendingDecisionCount: 0,
    activeTaskCount: 0,
    turnRunning: false,
    taskCount: 2,
    turnCount: 3,
    costUsd: 0.42,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("OrchestratorCaseList", () => {
  beforeEach(() => {
    mocks.cases.data = undefined;
    mocks.cases.isLoading = false;
    mocks.cases.error = null;
  });

  it("links each case to its detail page", () => {
    mocks.cases.data = [
      summary({ id: "case-1" }),
      summary({ id: "case-2", title: "Second", pendingDecisionCount: 2 }),
    ];
    render(<OrchestratorCaseList workflowId="w1" />);

    expect(
      screen.getByRole("link", { name: "PROJ-7 login bug" })
    ).toHaveAttribute("href", "/acme/orchestrator/cases/case-1");
    expect(screen.getByRole("link", { name: "Second" })).toHaveAttribute(
      "href",
      "/acme/orchestrator/cases/case-2"
    );
    expect(screen.getByText("2 pending")).toBeTruthy();
  });

  it("renders the runs-style columns", () => {
    mocks.cases.data = [summary({})];
    render(<OrchestratorCaseList workflowId="w1" />);

    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent)
    ).toEqual(["Case", "Status", "Last activity", "Tasks", "Turns", "Cost"]);
  });

  it("shows the cost, or a dash when unknown", () => {
    mocks.cases.data = [
      summary({ id: "a", costUsd: 0.42 }),
      summary({ id: "b", title: "Second", costUsd: null }),
    ];
    render(<OrchestratorCaseList workflowId="w1" />);

    expect(screen.getByText("$0.42")).toBeTruthy();
    expect(screen.getByText("-")).toBeTruthy();
  });

  it("flags a running case", () => {
    mocks.cases.data = [summary({ turnRunning: true })];
    render(<OrchestratorCaseList workflowId="w1" />);

    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("shows the empty state", () => {
    mocks.cases.data = [];
    render(<OrchestratorCaseList workflowId="w1" />);

    expect(screen.getByText("No cases yet.")).toBeTruthy();
    expect(screen.queryByTestId("orchestrator-case-list")).toBeNull();
  });
});
