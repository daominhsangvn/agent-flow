import {
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWait,
  evaluateWaits,
  fireDueDeadlines,
  waitReason,
} from "@/lib/orchestrator/waits";

/**
 * A conversation's waits (docs/orchestrator.md): decided in code, recorded
 * without waking anyone until the condition holds, fired once with the
 * tasks' results.
 */

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-23T09:00:00.000Z");

const mocks = vi.hoisted(() => ({
  waits: [] as Row[],
  tasks: [] as Row[],
  messages: [] as Row[],
  conversations: [] as Row[],
}));

vi.mock("@repo/database", () => {
  const db = {
    orchestratorWait: {
      create: (args: { data: Row }) => {
        const row = {
          id: `wait-${mocks.waits.length + 1}`,
          firedAt: null,
          createdAt: NOW,
          ...args.data,
        };
        mocks.waits.push(row);
        return Promise.resolve(row);
      },
      findMany: (args: { where: Row }) =>
        Promise.resolve(
          mocks.waits.filter((wait) => {
            if (wait.firedAt !== null) {
              return false;
            }
            if (args.where.conversationId) {
              return wait.conversationId === args.where.conversationId;
            }
            const deadline = wait.deadline as Date | null;
            return deadline !== null && deadline <= NOW;
          })
        ),
      updateMany: (args: { where: { id: string }; data: Row }) => {
        const wait = mocks.waits.find(
          (row) => row.id === args.where.id && row.firedAt === null
        );
        if (!wait) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(wait, args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    orchestratorTask: {
      findMany: (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          mocks.tasks.filter((task) =>
            args.where.id.in.includes(task.id as string)
          )
        ),
    },
    orchestratorMessage: {
      create: (args: { data: Row }) => {
        mocks.messages.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    orchestratorConversation: {
      update: (args: { where: { id: string }; data: Row }) => {
        mocks.conversations.push({ id: args.where.id, ...args.data });
        return Promise.resolve({});
      },
    },
  };
  const withDb = (fn: (client: unknown) => unknown) => fn(db);
  withDb.tx = (fn: (client: unknown) => unknown) => fn(db);
  return { withDb };
});

function task(id: string, status: string, result: unknown = null): Row {
  return {
    id,
    command: "/ba-requirement",
    args: "LD-7",
    status,
    result,
    computeTarget: { machineName: "runner-1" },
  };
}

beforeEach(() => {
  mocks.waits = [];
  mocks.tasks = [];
  mocks.messages = [];
  mocks.conversations = [];
});

async function waitFor(
  taskIds: string[],
  options: Partial<{
    kind: OrchestratorWaitKind;
    timeoutMinutes: number | null;
    wakeOnFailure: boolean;
  }> = {}
) {
  await createWait(
    {
      organizationId: "org-1",
      conversationId: "conversation-1",
      kind: options.kind ?? OrchestratorWaitKind.All,
      taskIds,
      timeoutMinutes: options.timeoutMinutes ?? null,
      wakeOnFailure: options.wakeOnFailure ?? true,
    },
    new Date(NOW.getTime() - 60 * 60_000)
  );
}

describe("waitReason", () => {
  const wait = {
    kind: OrchestratorWaitKind.All,
    deadline: null,
    wakeOnFailure: true,
  };

  it("waits until every task finished", () => {
    expect(
      waitReason(
        wait,
        [
          { status: OrchestratorTaskStatus.Succeeded },
          { status: OrchestratorTaskStatus.Running },
        ],
        NOW
      )
    ).toBeNull();
    expect(
      waitReason(
        wait,
        [
          { status: OrchestratorTaskStatus.Succeeded },
          { status: OrchestratorTaskStatus.Failed },
        ],
        NOW
      )
    ).toBe("done");
  });

  it("takes the first finished task for any", () => {
    expect(
      waitReason(
        { ...wait, kind: OrchestratorWaitKind.Any },
        [
          { status: OrchestratorTaskStatus.Succeeded },
          { status: OrchestratorTaskStatus.Queued },
        ],
        NOW
      )
    ).toBe("done");
  });

  it("wakes at a failure unless asked not to", () => {
    const tasks = [
      { status: OrchestratorTaskStatus.Failed },
      { status: OrchestratorTaskStatus.Running },
    ];
    expect(waitReason(wait, tasks, NOW)).toBe("failure");
    expect(
      waitReason({ ...wait, wakeOnFailure: false }, tasks, NOW)
    ).toBeNull();
  });

  it("wakes at a cancel whatever wakeOnFailure says", () => {
    const tasks = [
      { status: OrchestratorTaskStatus.Running },
      { status: OrchestratorTaskStatus.Cancelled },
    ];
    expect(waitReason({ ...wait, wakeOnFailure: false }, tasks, NOW)).toBe(
      "cancelled"
    );
    expect(
      waitReason(wait, [{ status: OrchestratorTaskStatus.Cancelled }], NOW)
    ).toBe("cancelled");
    expect(
      waitReason(
        wait,
        [
          { status: OrchestratorTaskStatus.Cancelled },
          { status: OrchestratorTaskStatus.Succeeded },
        ],
        NOW
      )
    ).toBe("done");
  });

  it("wakes at the deadline with where the tasks are", () => {
    expect(
      waitReason(
        { ...wait, deadline: NOW },
        [{ status: OrchestratorTaskStatus.Running }],
        NOW
      )
    ).toBe("deadline");
  });
});

describe("evaluateWaits", () => {
  it("records a finished task without waking anyone while another runs", async () => {
    mocks.tasks = [
      task("task-1", OrchestratorTaskStatus.Succeeded),
      task("task-2", OrchestratorTaskStatus.Running),
    ];
    await waitFor(["task-1", "task-2"]);

    expect(await evaluateWaits("conversation-1", NOW)).toBe(false);
    expect(mocks.messages).toEqual([]);
  });

  it("lists a succeeded task's files with sizes and skipped reasons", async () => {
    mocks.tasks = [
      task("task-1", OrchestratorTaskStatus.Succeeded, {
        reply: null,
        questions: [],
        error: null,
        files: [
          {
            name: "PRD-LD-5.md",
            size: 12_595,
            storageKey: "k1",
            skipped: null,
          },
          {
            name: "evidence-LD-5/a.png",
            size: 9_000_000,
            storageKey: null,
            skipped: "larger than 4 MB",
          },
        ],
        filesOmitted: 2,
      }),
    ];
    await waitFor(["task-1"]);

    expect(await evaluateWaits("conversation-1", NOW)).toBe(true);
    const text = mocks.messages[0]?.text as string;
    expect(text).toContain(
      "Files: PRD-LD-5.md (12.3 KB), evidence-LD-5/a.png (not collected: larger than 4 MB) and 2 more not collected (over 20 files)"
    );
  });

  it("fires once with the tasks' answers and questions, and makes the next turn due", async () => {
    mocks.tasks = [
      task("task-1", OrchestratorTaskStatus.Succeeded, {
        reply: "Half days are allowed (policy v3.1 §4).",
        questions: [],
        error: null,
      }),
      task("task-2", OrchestratorTaskStatus.Succeeded, {
        reply: null,
        questions: [
          { id: "q1", question: "Part-timers too?", options: ["yes", "no"] },
        ],
        error: null,
      }),
    ];
    await waitFor(["task-1", "task-2"]);

    expect(await evaluateWaits("conversation-1", NOW)).toBe(true);
    expect(await evaluateWaits("conversation-1", NOW)).toBe(false);

    expect(mocks.messages).toHaveLength(1);
    expect(mocks.messages[0]).toMatchObject({
      origin: OrchestratorMessageOrigin.Internal,
      kind: OrchestratorMessageKind.TaskResults,
      dedupKey: "wait:wait-1",
    });
    const text = mocks.messages[0]?.text as string;
    expect(text).toContain("The tasks you waited for (all) are done.");
    expect(text).toContain("Half days are allowed (policy v3.1 §4).");
    expect(text).toContain("q1: Part-timers too? (options: yes | no)");
    expect(text).toContain("resumeTaskId task-2");
    expect(mocks.conversations).toEqual([
      { id: "conversation-1", nextWakeAt: NOW },
    ]);
  });

  it("shows the cancel reason and no resume hint", async () => {
    mocks.tasks = [
      task("task-1", OrchestratorTaskStatus.Cancelled, {
        reply: null,
        questions: [{ id: "q1", question: "Part-timers too?" }],
        error: null,
        cancelled: "label create-prd removed",
      }),
      task("task-2", OrchestratorTaskStatus.Running),
    ];
    await waitFor(["task-1", "task-2"], { wakeOnFailure: false });

    expect(await evaluateWaits("conversation-1", NOW)).toBe(true);
    const text = mocks.messages[0]?.text as string;
    expect(text).toContain("cancelled: label create-prd removed");
    expect(text).not.toContain("resumeTaskId");
  });

  it("shows why a queued task waits when the deadline passes", async () => {
    mocks.tasks = [
      task("task-1", OrchestratorTaskStatus.Queued, {
        reply: null,
        questions: [],
        error: null,
        waiting: "Waiting for an-PRO-1: it runs one task at a time.",
      }),
    ];
    await waitFor(["task-1"], { timeoutMinutes: 30 });

    await fireDueDeadlines(NOW);

    expect(mocks.messages[0]?.text).toContain(
      "  Waiting: Waiting for an-PRO-1: it runs one task at a time."
    );
  });

  it("fires a passed deadline from the tick", async () => {
    mocks.tasks = [task("task-1", OrchestratorTaskStatus.Running)];
    await waitFor(["task-1"], { timeoutMinutes: 30 });

    expect(await fireDueDeadlines(NOW)).toBe(1);
    expect(mocks.messages[0]).toMatchObject({
      kind: OrchestratorMessageKind.Deadline,
    });
  });
});
