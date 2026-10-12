import {
  WORKFLOW_RUN_FINAL_STATUSES,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvanceRunOutcome } from "@/lib/workflows/engine/advance";
import {
  runWorkflowTick,
  TICK_ADVANCE_LIMIT,
  TICK_DRAIN_LIMIT,
} from "@/lib/workflows/engine/tick";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  pollDueConnections: vi.fn(),
  advanceRun: vi.fn(),
  requeueStaleActionRuns: vi.fn(),
  drainActionRuns: vi.fn(),
  order: [] as string[],
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ workflowRun: { findMany: mocks.findMany } }),
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/workflows/engine/poll", () => ({
  pollDueConnections: mocks.pollDueConnections,
}));
// advance.ts pulls in the whole launch graph; the tick only needs its outcome
// values, mirrored here.
vi.mock("@/lib/workflows/engine/advance", () => ({
  AdvanceRunOutcome: { Skipped: "skipped", Advanced: "advanced" },
  advanceRun: mocks.advanceRun,
}));
vi.mock("@/lib/workflows/engine/actions", () => ({
  requeueStaleActionRuns: mocks.requeueStaleActionRuns,
  drainActionRuns: mocks.drainActionRuns,
}));

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DRAINED = { claimed: 2, succeeded: 2, skipped: 0, retried: 0, failed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.pollDueConnections.mockImplementation(() => {
    mocks.order.push("poll");
    return Promise.resolve({ polled: 1, failed: 0, events: 1, runs: 1 });
  });
  mocks.findMany.mockResolvedValue([{ id: "run-1" }, { id: "run-2" }]);
  mocks.advanceRun.mockImplementation((id: string) => {
    mocks.order.push(`advance:${id}`);
    return Promise.resolve(
      id === "run-1" ? AdvanceRunOutcome.Advanced : AdvanceRunOutcome.Skipped
    );
  });
  mocks.requeueStaleActionRuns.mockImplementation(() => {
    mocks.order.push("requeue");
    return Promise.resolve(1);
  });
  mocks.drainActionRuns.mockImplementation(() => {
    mocks.order.push("drain");
    return Promise.resolve(DRAINED);
  });
});

describe("runWorkflowTick", () => {
  it("polls, advances, requeues and drains in that order", async () => {
    const result = await runWorkflowTick(NOW);

    expect(mocks.order).toEqual([
      "poll",
      "advance:run-1",
      "advance:run-2",
      "requeue",
      "drain",
    ]);
    expect(result).toMatchObject({
      poll: { polled: 1, runs: 1 },
      runs: { checked: 2, advanced: 1 },
      actionRuns: { ...DRAINED, requeued: 1 },
      errors: [],
    });
    expect(mocks.drainActionRuns).toHaveBeenCalledWith({
      limit: TICK_DRAIN_LIMIT,
      now: NOW,
    });
  });

  it("advances non-final runs that are not leased and not waiting for a step retry, oldest first", async () => {
    await runWorkflowTick(NOW);

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        status: { notIn: [...WORKFLOW_RUN_FINAL_STATUSES] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: NOW } }],
        AND: [{ OR: [{ nextStepAt: null }, { nextStepAt: { lte: NOW } }] }],
      },
      orderBy: { updatedAt: "asc" },
      take: TICK_ADVANCE_LIMIT,
      select: { id: true },
    });
    // Runs waiting for a pre action retry are advanced like any other.
    expect(WORKFLOW_RUN_FINAL_STATUSES).not.toContain(
      WorkflowRunStatus.PreActions
    );
  });

  it("keeps going when a stage fails and reports the error", async () => {
    mocks.pollDueConnections.mockRejectedValue(new Error("poll exploded"));

    const result = await runWorkflowTick(NOW);

    expect(result.errors).toEqual(["poll: poll exploded"]);
    expect(result.poll).toEqual({ polled: 0, failed: 0, events: 0, runs: 0 });
    expect(mocks.drainActionRuns).toHaveBeenCalled();
    expect(result.runs.checked).toBe(2);
  });
});
