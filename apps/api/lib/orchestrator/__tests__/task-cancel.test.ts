import {
  OrchestratorMessageKind,
  OrchestratorTaskStatus,
  OrchestratorTicketChange,
} from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelOnRefusal,
  cancelTask,
  taskCancelledMessage,
} from "@/lib/orchestrator/task-cancel";

type Row = Record<string, unknown>;

const IDS = {
  org: "org-1",
  case: "case-1",
  turn: "turn-1",
  task: "task-1",
  loop: "loop-1",
  target: "target-1",
};

const mocks = vi.hoisted(() => ({
  tasks: [] as Row[],
  messageKinds: [] as string[],
  cancelOn: [] as string[],
  waits: [] as Array<{ conversationId: string }>,
  cancelLoop: vi.fn(),
  evaluateWaits: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorCase: {
      findFirst: () => Promise.resolve({ workflowId: "wf-1" }),
    },
    orchestratorMessage: {
      count: (args: { where: { kind: { in: string[] } } }) =>
        Promise.resolve(
          mocks.messageKinds.filter((kind) => args.where.kind.in.includes(kind))
            .length
        ),
    },
    orchestratorTask: {
      findFirst: (args: { where: Row }) =>
        Promise.resolve(
          mocks.tasks.find(
            (task) =>
              task.id === args.where.id && task.caseId === args.where.caseId
          ) ?? null
        ),
      updateMany: (args: { where: Row; data: Row }) => {
        const rows = mocks.tasks.filter(
          (task) =>
            task.id === args.where.id && task.status === args.where.status
        );
        for (const row of rows) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      },
    },
    orchestratorWait: {
      findMany: () => Promise.resolve(mocks.waits),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});

vi.mock("@/lib/orchestrator/workflow-settings", () => ({
  loadOrchestratorWorkflows: () =>
    Promise.resolve(new Map([["wf-1", { cancelOn: mocks.cancelOn }]])),
}));

vi.mock("@/lib/workflows/engine/cancel", () => ({
  cancelLoop: mocks.cancelLoop,
}));

vi.mock("@/lib/orchestrator/waits", () => ({
  evaluateWaits: mocks.evaluateWaits,
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const input = {
  organizationId: IDS.org,
  caseId: IDS.case,
  turnId: IDS.turn,
  taskId: IDS.task,
  reason: "label create-prd removed",
};

function seedTask(overrides: Row = {}): Row {
  const row: Row = {
    id: IDS.task,
    caseId: IDS.case,
    status: OrchestratorTaskStatus.Running,
    loopId: IDS.loop,
    computeTargetId: IDS.target,
    result: { reply: "partial", questions: [], error: null },
    ...overrides,
  };
  mocks.tasks.push(row);
  return row;
}

beforeEach(() => {
  mocks.tasks = [];
  mocks.messageKinds = [OrchestratorMessageKind.StatusChanged];
  mocks.cancelOn = [
    OrchestratorTicketChange.StatusChanged,
    OrchestratorTicketChange.LabelRemoved,
  ];
  mocks.waits = [];
  mocks.cancelLoop.mockReset().mockResolvedValue(true);
  mocks.evaluateWaits.mockReset().mockResolvedValue(true);
});

describe("cancelTask", () => {
  it("refuses a turn that took only comments", async () => {
    const task = seedTask();
    mocks.messageKinds = [OrchestratorMessageKind.Message];
    const result = await cancelTask(input);
    expect(result).toEqual({
      ok: false,
      error: cancelOnRefusal(mocks.cancelOn),
    });
    expect(task.status).toBe(OrchestratorTaskStatus.Running);
    expect(mocks.cancelLoop).not.toHaveBeenCalled();
  });

  it("refuses a change that cancelOn does not list", async () => {
    seedTask();
    mocks.cancelOn = [OrchestratorTicketChange.StatusChanged];
    mocks.messageKinds = [OrchestratorMessageKind.LabelRemoved];
    const result = await cancelTask(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("status_changed");
  });

  it("refuses everything when cancelOn is empty", async () => {
    seedTask();
    mocks.cancelOn = [];
    const result = await cancelTask(input);
    expect(result).toEqual({ ok: false, error: cancelOnRefusal([]) });
    expect(!result.ok && result.error).toContain("allows nothing");
  });

  it("stops a running task's loop and closes it", async () => {
    const task = seedTask();
    const result = await cancelTask(input);
    expect(result).toEqual({
      ok: true,
      value: {
        taskId: IDS.task,
        previous: OrchestratorTaskStatus.Running,
        alreadyCancelled: false,
        loopStopped: true,
      },
    });
    expect(mocks.cancelLoop).toHaveBeenCalledWith(
      IDS.loop,
      IDS.target,
      IDS.org,
      expect.stringContaining(input.reason)
    );
    expect(task.status).toBe(OrchestratorTaskStatus.Cancelled);
    expect(task.result).toMatchObject({
      cancelled: input.reason,
      cancelledFrom: OrchestratorTaskStatus.Running,
    });
  });

  it("cancels a queued task without stopping a loop", async () => {
    const task = seedTask({
      status: OrchestratorTaskStatus.Queued,
      loopId: null,
    });
    const result = await cancelTask(input);
    expect(result.ok).toBe(true);
    expect(task.status).toBe(OrchestratorTaskStatus.Cancelled);
    expect(mocks.cancelLoop).not.toHaveBeenCalled();
  });

  it("keeps the reply and questions of a finished task", async () => {
    const questions = [{ id: "q1", question: "Which?" }];
    const task = seedTask({
      status: OrchestratorTaskStatus.Succeeded,
      result: { reply: "done", questions, error: null },
    });
    await cancelTask(input);
    expect(task.status).toBe(OrchestratorTaskStatus.Cancelled);
    expect(task.result).toMatchObject({
      reply: "done",
      questions,
      cancelledFrom: OrchestratorTaskStatus.Succeeded,
    });
    expect(mocks.cancelLoop).not.toHaveBeenCalled();
  });

  it("evaluates the open waits of other conversations of the case", async () => {
    seedTask();
    mocks.waits = [{ conversationId: "conv-a" }, { conversationId: "conv-b" }];
    await cancelTask(input);
    expect(mocks.evaluateWaits.mock.calls.map((call) => call[0])).toEqual([
      "conv-a",
      "conv-b",
    ]);
  });

  it("refuses a task of another case", async () => {
    seedTask({ caseId: "other-case" });
    const result = await cancelTask(input);
    expect(result).toEqual({
      ok: false,
      error: "No task of this case has that id.",
    });
  });

  it("returns ok for an already cancelled task", async () => {
    seedTask({ status: OrchestratorTaskStatus.Cancelled });
    const result = await cancelTask(input);
    expect(result.ok && result.value.alreadyCancelled).toBe(true);
    expect(mocks.cancelLoop).not.toHaveBeenCalled();
  });

  it("still cancels the task when stopping its loop throws", async () => {
    const task = seedTask();
    mocks.cancelLoop.mockRejectedValue(new Error("gateway down"));
    const result = await cancelTask(input);
    expect(result.ok && result.value.loopStopped).toBe(false);
    expect(task.status).toBe(OrchestratorTaskStatus.Cancelled);
  });
});

describe("taskCancelledMessage", () => {
  it("names the reason of a cancelled task", () => {
    expect(
      taskCancelledMessage({
        reply: null,
        questions: [],
        error: null,
        cancelled: "status left",
      })
    ).toContain("status left");
  });

  it("is null for a task that was not cancelled", () => {
    expect(
      taskCancelledMessage({ reply: null, questions: [], error: null })
    ).toBeNull();
  });
});
