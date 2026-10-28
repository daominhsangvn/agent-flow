import {
  OrchestratorCaseStatus,
  OrchestratorDecisionStatus,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
} from "@repo/api/src/types/orchestrator";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorCaseService } from "@/app/orchestrator/cases/service";

const ORG = "org-1";
const CASE_ID = "case-1";
const D = (iso: string) => new Date(iso);

const mocks = vi.hoisted(() => ({
  caseFindMany: vi.fn(),
  workflowFindFirst: vi.fn(),
  caseFindFirst: vi.fn(),
  caseUpdateMany: vi.fn(),
  turnFindMany: vi.fn(),
  turnFindFirst: vi.fn(),
  turnUpdateMany: vi.fn(),
  userFindFirst: vi.fn(),
  cancel: vi.fn(),
  loadCaseStats: vi.fn(),
}));

vi.mock("@/app/orchestrator/cases/service/case-stats", () => ({
  loadCaseStats: mocks.loadCaseStats,
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorCase: {
      findMany: mocks.caseFindMany,
      findFirst: mocks.caseFindFirst,
      updateMany: mocks.caseUpdateMany,
    },
    orchestratorTurn: {
      findMany: mocks.turnFindMany,
      findFirst: mocks.turnFindFirst,
      updateMany: mocks.turnUpdateMany,
    },
    user: { findFirst: mocks.userFindFirst },
    workflow: { findFirst: mocks.workflowFindFirst },
  };
  const withDb = (fn: (client: unknown) => unknown) => fn(db);
  withDb.tx = (fn: (client: unknown) => unknown) => fn(db);
  return { withDb };
});
vi.mock("@/lib/loops/loop-desktop", () => ({
  dispatchOrchestratorTurnCancel: mocks.cancel,
}));

const SUMMARY_ROW = {
  id: CASE_ID,
  projectId: "project-1",
  workflowId: "workflow-1",
  title: "LD-7",
  sourceKey: "jira:LD-7",
  status: OrchestratorCaseStatus.Open,
  createdAt: D("2026-10-23T08:00:00.000Z"),
  updatedAt: D("2026-10-23T09:00:00.000Z"),
  _count: { conversations: 1, decisions: 2, tasks: 3 },
};

const DETAIL_ROW = {
  ...SUMMARY_ROW,
  notes: "n",
  project: { id: "project-1", name: "Leave" },
  workflow: { id: "workflow-1", name: "Questions" },
  conversations: [
    {
      id: "conv-1",
      channelKey: "jira:LD-7:item",
      status: "waiting",
      createdAt: D("2026-10-23T08:00:00.000Z"),
      messages: [
        {
          id: "m2",
          conversationId: "conv-1",
          origin: "external",
          kind: "message",
          actor: "An",
          text: "second",
          turnId: null,
          createdAt: D("2026-10-23T08:02:00.000Z"),
        },
        {
          id: "m1",
          conversationId: "conv-1",
          origin: "external",
          kind: "message",
          actor: "An",
          text: "first",
          turnId: null,
          createdAt: D("2026-10-23T08:01:00.000Z"),
        },
      ],
      turns: [
        {
          id: "t-running",
          conversationId: "conv-1",
          status: "running",
          ended: null,
          summary: null,
          error: null,
          usage: { timeoutMs: 600_000 },
          startedAt: D("2026-10-23T08:05:00.000Z"),
          finishedAt: null,
          createdAt: D("2026-10-23T08:05:00.000Z"),
          computeTarget: { machineName: "runner-1" },
        },
        {
          id: "t-done",
          conversationId: "conv-1",
          status: "succeeded",
          ended: "wait_human",
          summary: "ok",
          error: null,
          usage: { costUsd: 0.02, inputTokens: 1200, outputTokens: 300 },
          startedAt: D("2026-10-23T08:03:00.000Z"),
          finishedAt: D("2026-10-23T08:04:00.000Z"),
          createdAt: D("2026-10-23T08:03:00.000Z"),
          computeTarget: null,
        },
      ],
      waits: [
        {
          id: "w1",
          conversationId: "conv-1",
          kind: "all",
          taskIds: ["task-1"],
          deadline: null,
          wakeOnFailure: true,
          firedAt: null,
          createdAt: D("2026-10-23T08:06:00.000Z"),
        },
      ],
    },
  ],
  tasks: [
    {
      id: "task-1",
      conversationId: "conv-1",
      turnId: "t-done",
      command: "/plan",
      args: "",
      prompt: "p",
      mode: "read",
      computeTargetId: "r1",
      computeTarget: { machineName: "runner-1" },
      status: OrchestratorTaskStatus.Failed,
      fork: false,
      resumeTaskId: null,
      loopId: null,
      result: {
        reply: "answer",
        questions: [{ id: "q1", question: "Which?" }],
        error: "boom",
        waiting: "Waiting for runner-1.",
        files: [
          { name: "PRD.md", size: 1200, storageKey: "k/PRD.md", skipped: null },
          {
            name: "big.bin",
            size: 9_000_000,
            storageKey: null,
            skipped: "too large",
          },
        ],
        filesOmitted: 2,
      },
      createdAt: D("2026-10-23T08:03:30.000Z"),
      finishedAt: null,
    },
  ],
  decisions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.turnFindMany.mockResolvedValue([]);
  mocks.loadCaseStats.mockResolvedValue(
    new Map([[CASE_ID, { taskCount: 4, turnCount: 5, costUsd: 0.5 }]])
  );
  mocks.workflowFindFirst.mockResolvedValue({ id: "workflow-1" });
});

describe("orchestratorCaseService.listForWorkflow", () => {
  it("scopes by organization and workflow, bounded, with counts", async () => {
    mocks.caseFindMany.mockResolvedValue([SUMMARY_ROW]);
    mocks.turnFindMany.mockResolvedValue([
      { conversation: { caseId: CASE_ID } },
    ]);

    const list = await orchestratorCaseService.listForWorkflow(
      ORG,
      "workflow-1"
    );

    const args = mocks.caseFindMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      organizationId: ORG,
      workflowId: "workflow-1",
    });
    expect(args.take).toBe(100);
    expect(args.select._count.select.decisions.where.status).toBe(
      OrchestratorDecisionStatus.Pending
    );
    expect(mocks.turnFindMany.mock.calls[0]?.[0].where).toMatchObject({
      organizationId: ORG,
      status: OrchestratorTurnStatus.Running,
    });
    expect(list?.[0]).toMatchObject({
      id: CASE_ID,
      workflowId: "workflow-1",
      conversationCount: 1,
      pendingDecisionCount: 2,
      activeTaskCount: 3,
      turnRunning: true,
      taskCount: 4,
      turnCount: 5,
      costUsd: 0.5,
      updatedAt: "2026-10-23T09:00:00.000Z",
    });
  });
});

describe("orchestratorCaseService.listForWorkflow unknown workflow", () => {
  it("is null for an unknown or other-organization workflow", async () => {
    mocks.workflowFindFirst.mockResolvedValue(null);

    expect(
      await orchestratorCaseService.listForWorkflow(ORG, "nope")
    ).toBeNull();
    expect(mocks.workflowFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "nope",
      organizationId: ORG,
    });
    expect(mocks.caseFindMany).not.toHaveBeenCalled();
  });
});

describe("orchestratorCaseService.get", () => {
  it("is null for an unknown or other-organization case", async () => {
    mocks.caseFindFirst.mockResolvedValue(null);

    expect(await orchestratorCaseService.get(ORG, "nope")).toBeNull();
    expect(mocks.caseFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "nope",
      organizationId: ORG,
    });
  });

  it("maps the rows: oldest-first, task results, usage", async () => {
    mocks.caseFindFirst.mockResolvedValue(DETAIL_ROW);

    const detail = await orchestratorCaseService.get(ORG, CASE_ID);

    const conversation = detail?.conversations[0];
    expect(conversation?.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
    expect(conversation?.turns.map((t) => t.id)).toEqual([
      "t-done",
      "t-running",
    ]);
    expect(conversation?.turns[0]?.usage).toEqual({
      costUsd: 0.02,
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(conversation?.turns[1]?.usage).toBeNull();
    expect(conversation?.turns[1]?.runnerName).toBe("runner-1");
    expect(detail?.tasks[0]).toMatchObject({
      reply: "answer",
      questions: [{ id: "q1", question: "Which?" }],
      error: "boom",
      runnerName: "runner-1",
      waiting: "Waiting for runner-1.",
      filesOmitted: 2,
    });
    expect(detail?.tasks[0]?.files).toEqual([
      { name: "PRD.md", size: 1200, stored: true, skipped: null },
      { name: "big.bin", size: 9_000_000, stored: false, skipped: "too large" },
    ]);
    expect(detail?.workflow).toEqual({ id: "workflow-1", name: "Questions" });
    expect(detail?.waits[0]?.taskIds).toEqual(["task-1"]);
  });
});

describe("orchestratorCaseService.getLoops", () => {
  it("is null for an unknown or other-organization case", async () => {
    mocks.caseFindFirst.mockResolvedValue(null);

    expect(await orchestratorCaseService.getLoops(ORG, "nope")).toBeNull();
    expect(mocks.caseFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "nope",
      organizationId: ORG,
    });
  });
});

describe("orchestratorCaseService.setStatus", () => {
  it("sets the status of an organization's case", async () => {
    mocks.caseUpdateMany.mockResolvedValue({ count: 1 });

    const result = await orchestratorCaseService.setStatus(ORG, CASE_ID, {
      status: OrchestratorCaseStatus.Closed,
    });

    expect(mocks.caseUpdateMany).toHaveBeenCalledWith({
      where: { id: CASE_ID, organizationId: ORG },
      data: { status: OrchestratorCaseStatus.Closed },
    });
    expect(result).toEqual({
      ok: true,
      value: { status: OrchestratorCaseStatus.Closed },
    });
  });

  it("is not found for a missing or other-organization case", async () => {
    mocks.caseUpdateMany.mockResolvedValue({ count: 0 });

    const result = await orchestratorCaseService.setStatus(ORG, "nope", {
      status: OrchestratorCaseStatus.Open,
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });
});

describe("orchestratorCaseService.cancelTurn", () => {
  beforeEach(() => {
    mocks.turnFindFirst.mockResolvedValue({
      id: "t1",
      computeTargetId: "r1",
      usage: { timeoutMs: 600_000 },
    });
    mocks.userFindFirst.mockResolvedValue({
      firstName: "Ann",
      lastName: "Admin",
      email: "ann@example.com",
    });
    mocks.cancel.mockResolvedValue("cmd");
    mocks.turnUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("is not found and does not dispatch when the turn settled before the write", async () => {
    mocks.turnUpdateMany.mockResolvedValue({ count: 0 });

    const result = await orchestratorCaseService.cancelTurn(ORG, "u1", "t1");

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.turnUpdateMany.mock.calls[0]?.[0].where).toEqual({
      id: "t1",
      organizationId: ORG,
      status: OrchestratorTurnStatus.Running,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("is not found when no such running turn exists", async () => {
    mocks.turnFindFirst.mockResolvedValue(null);

    const result = await orchestratorCaseService.cancelTurn(ORG, "u1", "t1");

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.turnFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "t1",
      organizationId: ORG,
      status: OrchestratorTurnStatus.Running,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("marks the turn and asks the runner to stop it", async () => {
    const result = await orchestratorCaseService.cancelTurn(ORG, "u1", "t1");

    expect(result).toEqual({ ok: true, value: { turnId: "t1" } });
    const usage = mocks.turnUpdateMany.mock.calls[0]?.[0].data.usage;
    expect(usage).toMatchObject({
      timeoutMs: 600_000,
      cancelledBy: "Ann Admin",
    });
    expect(typeof usage.cancelRequestedAt).toBe("string");
    expect(mocks.cancel).toHaveBeenCalledWith({
      computeTargetId: "r1",
      turnId: "t1",
    });
  });

  it("is a bad gateway when the runner cannot be reached", async () => {
    mocks.cancel.mockRejectedValue(new Error("offline"));

    const result = await orchestratorCaseService.cancelTurn(ORG, "u1", "t1");

    expect(result).toEqual({ ok: false, error: Status.BadGateway });
  });
});
