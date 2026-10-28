import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCaseLoops,
  toCaseLoops,
} from "@/app/orchestrator/cases/service/case-loops";

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  loopFindMany: vi.fn(),
  listRunSessions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      orchestratorTask: { findMany: mocks.taskFindMany },
      loop: { findMany: mocks.loopFindMany },
    }),
}));
vi.mock("@/lib/workflows/run-sessions", () => ({
  listRunSessions: mocks.listRunSessions,
}));

const loopRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "COMPLETED",
  prUrl: null,
  prNumber: null,
  branchName: null,
  repo: null,
  startedAt: null,
  completedAt: null,
  ...extra,
});

describe("toCaseLoops", () => {
  it("keeps task order and uses the task command", () => {
    const { loops } = toCaseLoops(
      [
        { command: "ba-prd", loopId: "l2" },
        { command: "dev-code", loopId: "l1" },
      ],
      [loopRow("l1"), loopRow("l2")]
    );

    expect(loops.map((l) => [l.loopId, l.command])).toEqual([
      ["l2", "ba-prd"],
      ["l1", "dev-code"],
    ]);
  });

  it("dedupes pull requests and reads repo.fullName", () => {
    const pr = {
      prUrl: "https://example.test/pr/1",
      prNumber: 1,
      branchName: "feat/x",
    };
    const { pullRequests } = toCaseLoops(
      [
        { command: "a", loopId: "l1" },
        { command: "b", loopId: "l2" },
        { command: "c", loopId: "l3" },
      ],
      [
        loopRow("l1", { ...pr, repo: { fullName: "acme/web" } }),
        loopRow("l2", { ...pr, repo: { fullName: "acme/web" } }),
        loopRow("l3", {
          prUrl: "https://example.test/pr/2",
          repo: { nope: true },
        }),
      ]
    );

    expect(pullRequests).toEqual([
      {
        url: "https://example.test/pr/1",
        number: 1,
        repository: "acme/web",
        branch: "feat/x",
      },
      {
        url: "https://example.test/pr/2",
        number: null,
        repository: null,
        branch: null,
      },
    ]);
  });

  it("skips tasks whose loop row is missing", () => {
    const { loops } = toCaseLoops([{ command: "a", loopId: "gone" }], []);

    expect(loops).toEqual([]);
  });
});

describe("loadCaseLoops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes no loop or session query without loop tasks", async () => {
    mocks.taskFindMany.mockResolvedValue([]);

    const result = await loadCaseLoops("org", "case-1");

    expect(result).toEqual({ loops: [], sessions: [], pullRequests: [] });
    expect(mocks.loopFindMany).not.toHaveBeenCalled();
    expect(mocks.listRunSessions).not.toHaveBeenCalled();
  });

  it("passes the task command to the session lookup", async () => {
    mocks.taskFindMany.mockResolvedValue([{ command: "ba-prd", loopId: "l1" }]);
    mocks.loopFindMany.mockResolvedValue([loopRow("l1")]);
    mocks.listRunSessions.mockResolvedValue([]);

    await loadCaseLoops("org", "case-1");

    expect(mocks.listRunSessions).toHaveBeenCalledWith("org", [
      { loopId: "l1", command: "ba-prd", stepId: null },
    ]);
  });
});
