import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  foldCaseStats,
  loadCaseStats,
} from "@/app/orchestrator/cases/service/case-stats";

const mocks = vi.hoisted(() => ({
  turnFindMany: vi.fn(),
  taskFindMany: vi.fn(),
  loopFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      orchestratorTurn: { findMany: mocks.turnFindMany },
      orchestratorTask: { findMany: mocks.taskFindMany },
      loop: { findMany: mocks.loopFindMany },
    }),
}));

const turn = (caseId: string, usage: unknown) => ({
  usage,
  conversation: { caseId },
});

describe("foldCaseStats", () => {
  it("counts turns and tasks per case", () => {
    const stats = foldCaseStats(
      ["a", "b"],
      [turn("a", null), turn("a", null), turn("b", null)],
      [{ caseId: "a", loopId: null }],
      new Map()
    );

    expect(stats.get("a")).toMatchObject({ taskCount: 1, turnCount: 2 });
    expect(stats.get("b")).toMatchObject({ taskCount: 0, turnCount: 1 });
  });

  it("leaves cost null when nothing is known", () => {
    const stats = foldCaseStats(
      ["a"],
      [turn("a", { timeoutMs: 1000 })],
      [{ caseId: "a", loopId: "l1" }],
      new Map([["l1", null]])
    );

    expect(stats.get("a")?.costUsd).toBeNull();
  });

  it("sums turn and loop cost and keeps a known zero", () => {
    const summed = foldCaseStats(
      ["a"],
      [turn("a", { costUsd: 0.25 })],
      [{ caseId: "a", loopId: "l1" }],
      new Map([["l1", 0.5]])
    );
    const zero = foldCaseStats(
      ["a"],
      [turn("a", { costUsd: 0 })],
      [],
      new Map()
    );

    expect(summed.get("a")?.costUsd).toBeCloseTo(0.75);
    expect(zero.get("a")?.costUsd).toBe(0);
  });
});

describe("loadCaseStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.turnFindMany.mockResolvedValue([]);
    mocks.taskFindMany.mockResolvedValue([]);
    mocks.loopFindMany.mockResolvedValue([]);
  });

  it("makes no query without cases", async () => {
    const stats = await loadCaseStats("org", []);

    expect(stats.size).toBe(0);
    expect(mocks.turnFindMany).not.toHaveBeenCalled();
    expect(mocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("skips the loop query when no task has a loop", async () => {
    mocks.taskFindMany.mockResolvedValue([{ caseId: "a", loopId: null }]);

    await loadCaseStats("org", ["a"]);

    expect(mocks.loopFindMany).not.toHaveBeenCalled();
  });

  it("reads loop cost in one query", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { caseId: "a", loopId: "l1" },
      { caseId: "a", loopId: "l1" },
    ]);
    mocks.loopFindMany.mockResolvedValue([{ id: "l1", estimatedCost: "1.5" }]);

    const stats = await loadCaseStats("org", ["a"]);

    expect(mocks.loopFindMany).toHaveBeenCalledTimes(1);
    expect(stats.get("a")?.costUsd).toBe(3);
  });
});
