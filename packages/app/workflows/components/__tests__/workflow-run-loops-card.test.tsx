import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import type { WorkflowRunLoopRef } from "@repo/api/src/types/workflow";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRunLoopsCard } from "../workflow-run-loops-card";

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

function makeLoop(overrides: Partial<WorkflowRunLoopRef>): WorkflowRunLoopRef {
  return {
    loopId: "loop-1",
    command: LoopCommand.Plan,
    status: LoopStatus.Completed,
    adopted: false,
    stepId: null,
    prUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const stepName = (stepId: string) => `Step ${stepId}`;

describe("WorkflowRunLoopsCard", () => {
  it("links the loop to its detail page", () => {
    render(
      <WorkflowRunLoopsCard
        loops={[makeLoop({ loopId: "abc" })]}
        stepName={stepName}
      />
    );
    expect(
      screen.getByRole("link", { name: "Plan" }).getAttribute("href")
    ).toBe("/acme/loops/abc");
  });

  it("shows a raw orchestrator command as-is", () => {
    render(
      <WorkflowRunLoopsCard
        loops={[makeLoop({ command: "ba-prd" })]}
        stepName={stepName}
      />
    );
    expect(screen.getByRole("link", { name: "ba-prd" })).toBeTruthy();
  });

  it("opens an http pull request externally", () => {
    render(
      <WorkflowRunLoopsCard
        loops={[makeLoop({ prUrl: "https://example.test/pr/1" })]}
        stepName={stepName}
      />
    );
    const link = screen.getByRole("link", { name: "Open" });
    expect(link.getAttribute("href")).toBe("https://example.test/pr/1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders a non-http pull request url as text", () => {
    render(
      <WorkflowRunLoopsCard
        loops={[makeLoop({ prUrl: "javascript:alert(1)" })]}
        stepName={stepName}
      />
    );
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  });

  it("shows the custom empty text without loops", () => {
    render(
      <WorkflowRunLoopsCard
        emptyText="No task has launched a loop yet."
        loops={[]}
        stepName={stepName}
      />
    );
    expect(screen.getByText("No task has launched a loop yet.")).toBeTruthy();
  });

  it("renders the step name", () => {
    render(
      <WorkflowRunLoopsCard
        loops={[makeLoop({ command: LoopCommand.Step, stepId: "triage" })]}
        stepName={stepName}
      />
    );
    expect(screen.getByText("Step triage")).toBeTruthy();
  });
});
