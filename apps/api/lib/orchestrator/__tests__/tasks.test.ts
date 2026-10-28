import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ORCHESTRATOR_TASK_REPLY_FILE,
  OrchestratorTaskStatus,
} from "@repo/api/src/types/orchestrator";
import {
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { WorkflowRunErrorCode } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTasks,
  buildTaskPrompt,
  startTask,
} from "@/lib/orchestrator/tasks";

/**
 * An orchestrator task (docs/orchestrator.md): a runner's command as a STEP
 * loop on the case's Issue for that runner, queued while a one-at-a-time
 * runner is busy, settled with the answer its agent left.
 */

type Row = Record<string, unknown>;

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  case: "0199a5f0-0000-7000-8000-0000000000b1",
  conversation: "0199a5f0-0000-7000-8000-0000000000b2",
  turn: "0199a5f0-0000-7000-8000-0000000000b3",
  ba: "0199a5f0-0000-7000-8000-0000000000c1",
  dev: "0199a5f0-0000-7000-8000-0000000000c2",
  owner: "0199a5f0-0000-7000-8000-0000000000a1",
};

const mocks = vi.hoisted(() => ({
  tasks: [] as Row[],
  loops: new Map<string, Row>(),
  busy: false,
  onBusyCheck: null as (() => void) | null,
  online: true,
  createLoop: vi.fn(),
  createDocument: vi.fn(),
  dispatch: vi.fn(),
  cancel: vi.fn(),
  settled: true,
  baToolkit: null as null | { repository: string; mounts: string[] },
  baAttach: undefined as string[] | undefined,
  stored: new Map<string, Uint8Array>(),
  runnerCapabilities: { loopStepForkSession: true } as Record<string, unknown>,
}));

vi.mock("@repo/database", () => {
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object") {
        const filter = value as Row;
        if ("not" in filter) {
          return row[key] !== filter.not;
        }
        if ("in" in filter) {
          return (filter.in as unknown[]).includes(row[key]);
        }
      }
      return row[key] === value;
    });
  const withCase = (row: Row) => ({
    ...row,
    case: { projectId: IDS.project, title: "LD-7: Half-day leave" },
    computeTarget: {
      userId: IDS.owner,
      machineName: row.computeTargetId === IDS.ba ? "runner-1" : "an-PRO-1",
      capabilities: mocks.runnerCapabilities,
      isOnline: mocks.online,
    },
  });
  const db = {
    orchestratorTask: {
      create: (args: { data: Row }) => {
        const row = {
          id: `task-${mocks.tasks.length + 1}`,
          loopId: null,
          documentId: null,
          createdAt: new Date(2026, 9, 23, 9, 0, mocks.tasks.length),
          ...args.data,
        };
        mocks.tasks.push(row);
        return Promise.resolve(row);
      },
      findUnique: (args: { where: { id: string } }) => {
        const row = mocks.tasks.find((task) => task.id === args.where.id);
        return Promise.resolve(row ? withCase(row) : null);
      },
      findFirst: (args: { where: Row }) =>
        Promise.resolve(
          mocks.tasks.find((task) => match(task, args.where)) ?? null
        ),
      findMany: (args: { where: Row }) =>
        Promise.resolve(mocks.tasks.filter((task) => match(task, args.where))),
      count: (args: { where: Row }) =>
        Promise.resolve(
          mocks.tasks.filter((task) => match(task, args.where)).length
        ),
      update: (args: { where: { id: string }; data: Row }) => {
        const row = mocks.tasks.find((task) => task.id === args.where.id);
        Object.assign(row ?? {}, args.data);
        return Promise.resolve(row);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const rows = mocks.tasks.filter((task) => match(task, args.where));
        for (const row of rows) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      },
    },
    user: {
      findFirst: () => Promise.resolve({ id: IDS.owner, clerkId: "clerk-1" }),
    },
    loop: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(mocks.loops.get(args.where.id) ?? null),
    },
  };
  return { withDb: (fn: (client: unknown) => unknown) => fn(db) };
});
vi.mock("@/app/compute-targets/capabilities-service", () => ({
  computeTargetCapabilitiesService: {
    listForProject: () =>
      Promise.resolve([
        {
          computeTargetId: IDS.ba,
          runnerName: "runner-1",
          source: RunnerCapabilitiesSource.Toolkit,
          capabilities: {
            runner: "BA",
            toolkit: mocks.baToolkit,
            commands: [
              {
                name: "/ba-requirement",
                mode: RunnerCommandMode.Read,
                asks: true,
                attach: mocks.baAttach,
              },
            ],
            skills: [],
          },
        },
        {
          computeTargetId: IDS.dev,
          runnerName: "an-PRO-1",
          source: RunnerCapabilitiesSource.Personal,
          capabilities: {
            runner: "Dev",
            commands: [
              {
                name: "/executing-plans",
                mode: RunnerCommandMode.Write,
                push: true,
              },
            ],
            skills: [],
          },
        },
      ]),
  },
}));
vi.mock("@/lib/loops/loop-state", () => ({
  getLoopPrefix: (org: string, loop: string) => `${org}/loops/${loop}/`,
  getLoopAttachment: (key: string) => {
    const bytes = mocks.stored.get(key);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error("gone"));
  },
}));
vi.mock("@/app/documents/document-service", () => ({
  documentService: { create: mocks.createDocument },
}));
vi.mock("@/app/loops/service", () => ({
  loopsService: { create: mocks.createLoop },
}));
vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts: () => Promise.resolve([{}]),
  findRepositoryCheckout: (_checkouts: unknown, fullName: string) =>
    fullName === "workshop/leavedesk-knowledge" ? {} : undefined,
  toLoopRepositorySelection: () => ({
    primary: { fullName: "workshop/leavedesk-app", branch: "main" },
    additional: [],
  }),
}));
vi.mock("@/lib/loops/launch-harness", () => ({
  resolveLaunchHarness: () => Promise.resolve(undefined),
}));
vi.mock("@/lib/loops/loop-dispatch-utils", () => ({
  dispatchAndClassify: mocks.dispatch,
}));
vi.mock("@/lib/workflows/engine/launch", async () => {
  const { WorkflowRunErrorCode: Code } = await import(
    "@repo/api/src/types/workflow"
  );
  return {
    checkCommandSigning: () => Promise.resolve({ ok: true, value: null }),
    cancelBlockedLoop: mocks.cancel,
    mapLoopCreateError: (error: { code?: string; message: string }) =>
      error.code === Code.LoopAlreadyActive
        ? { code: Code.LoopAlreadyActive, message: error.message }
        : null,
  };
});
vi.mock("@/lib/workflows/engine/personal-runner-queue", () => ({
  personalRunnerBusy: () => {
    mocks.onBusyCheck?.();
    return Promise.resolve(
      mocks.busy
        ? { code: "runner_busy", message: "Waiting for an-PRO-1: busy." }
        : null
    );
  },
}));
vi.mock("@/lib/workflows/engine/run-loops", () => ({
  isLoopSettled: () => Promise.resolve(mocks.settled),
}));
vi.mock("@/lib/orchestrator/case-render", () => ({
  renderCase: () => Promise.resolve("# LD-7"),
}));

const BASE = {
  organizationId: IDS.org,
  projectId: IDS.project,
  caseId: IDS.case,
  conversationId: IDS.conversation,
  turnId: IDS.turn,
  args: "LD-7",
  prompt: "Does the policy allow half days for part-timers?",
  mode: null,
  resumeTaskId: null,
  fork: false,
  files: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks = [];
  mocks.loops = new Map();
  mocks.busy = false;
  mocks.onBusyCheck = null;
  mocks.online = true;
  mocks.settled = true;
  mocks.baToolkit = null;
  mocks.baAttach = undefined;
  mocks.stored = new Map();
  mocks.runnerCapabilities = { loopStepForkSession: true };
  mocks.createDocument.mockResolvedValue({ id: "doc-1" });
  mocks.createLoop.mockResolvedValue({
    loopId: "loop-1",
    status: LoopStatus.Pending,
  });
  mocks.dispatch.mockResolvedValue({ ok: true });
});

describe("startTask", () => {
  it("runs the command as a STEP loop on the case's Issue for that runner", async () => {
    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started).toEqual({
      ok: true,
      value: {
        taskId: "task-1",
        status: OrchestratorTaskStatus.Running,
        runner: "runner-1",
        error: null,
        waiting: null,
      },
    });
    expect(mocks.createDocument).toHaveBeenCalledWith(IDS.org, IDS.owner, {
      type: DocumentType.Feature,
      title: "LD-7: Half-day leave · runner-1",
      content: "# LD-7",
      projectId: IDS.project,
      status: expect.any(String),
    });
    expect(mocks.createLoop).toHaveBeenCalledWith(
      IDS.org,
      IDS.owner,
      expect.objectContaining({
        command: LoopCommand.Step,
        documentId: "doc-1",
        computeTargetId: IDS.ba,
        prompt: expect.stringContaining(
          "/ba-requirement LD-7\n\nDoes the policy allow half days for part-timers?"
        ),
        metadata: {
          orchestratorTaskId: "task-1",
          step: {
            runId: IDS.case,
            stepId: "task-1",
            name: "/ba-requirement",
            fresh: true,
            askQuestions: true,
            artifacts: [ORCHESTRATOR_TASK_REPLY_FILE],
            finish: LoopStepFinish.None,
            toolkit: null,
            readOnly: true,
          },
        },
      })
    );
    expect(mocks.tasks[0]).toMatchObject({
      status: OrchestratorTaskStatus.Running,
      loopId: "loop-1",
      documentId: "doc-1",
      mode: RunnerCommandMode.Read,
    });
  });

  it("loads an auto runner's toolkit into the task's workspace", async () => {
    mocks.baToolkit = {
      repository: "workshop/leavedesk-knowledge",
      mounts: [".claude/agents", ".claude/skills"],
    };

    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(mocks.createLoop.mock.calls[0]?.[2].metadata.step.toolkit).toEqual({
      repository: "workshop/leavedesk-knowledge",
      mounts: [".claude/agents", ".claude/skills"],
      instructions: "",
    });
  });

  it("fails a task whose toolkit is not a project repository", async () => {
    mocks.baToolkit = {
      repository: "acme/elsewhere",
      mounts: [".claude/skills"],
    };

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Failed
    );
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("finds the runner by its role too, and refuses one that declared nothing", async () => {
    const byRole = await startTask({
      ...BASE,
      runner: "Dev",
      command: "/executing-plans",
    });
    const unknown = await startTask({
      ...BASE,
      runner: "runner-qc",
      command: "/qa",
    });

    expect(byRole.ok && byRole.value.runner).toBe("an-PRO-1");
    expect(unknown.ok ? "" : unknown.error).toContain('No runner "runner-qc"');
  });

  it("leaves pushing to a personal runner's own command", async () => {
    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
    });

    expect(mocks.createLoop.mock.calls[0]?.[2].metadata.step).toMatchObject({
      finish: LoopStepFinish.None,
    });
    expect(
      mocks.createLoop.mock.calls[0]?.[2].metadata.step.readOnly
    ).toBeUndefined();
  });

  it("reuses the runner's Issue and workspace for the case's later tasks", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.createLoop.mockResolvedValue({
      loopId: "loop-2",
      status: LoopStatus.Pending,
    });

    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
    expect(mocks.createLoop.mock.calls[1]?.[2]).toMatchObject({
      documentId: "doc-1",
      metadata: { step: { fresh: false } },
    });
  });

  it("resumes an earlier task's session on its runner, in a copy with fork", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.createLoop.mockResolvedValue({
      loopId: "loop-2",
      status: LoopStatus.Pending,
    });

    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      resumeTaskId: "task-1",
      fork: true,
    });
    const elsewhere = await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
      resumeTaskId: "task-1",
    });

    expect(mocks.createLoop.mock.calls[1]?.[2]).toMatchObject({
      parentLoopId: "loop-1",
      metadata: { step: { forkSession: true } },
    });
    expect(elsewhere.ok ? "" : elsewhere.error).toContain(
      "on the runner of the task"
    );
  });

  it("refuses to resume a cancelled task and creates no loop", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    Object.assign(mocks.tasks[0] ?? {}, {
      status: OrchestratorTaskStatus.Cancelled,
      result: {
        reply: null,
        questions: [],
        error: null,
        cancelled: "label removed",
      },
    });
    mocks.createLoop.mockClear();

    const resumed = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      resumeTaskId: "task-1",
    });

    expect(resumed.ok ? "" : resumed.error).toContain("label removed");
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("ends cancelled, with its loop cancelled, when task_cancel closes it before it starts", async () => {
    mocks.createLoop.mockImplementation(() => {
      Object.assign(mocks.tasks[0] ?? {}, {
        status: OrchestratorTaskStatus.Cancelled,
      });
      return Promise.resolve({ loopId: "loop-1", status: LoopStatus.Pending });
    });

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started.ok ? started.value.status : "").toBe(
      OrchestratorTaskStatus.Cancelled
    );
    expect(mocks.tasks[0]?.status).toBe(OrchestratorTaskStatus.Cancelled);
    expect(mocks.cancel).toHaveBeenCalledWith("loop-1", IDS.org);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not fork on a runner that cannot: it would continue the earlier session itself", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.runnerCapabilities = {};

    const forked = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      resumeTaskId: "task-1",
      fork: true,
    });

    expect(forked.ok && forked.value.status).toBe(
      OrchestratorTaskStatus.Failed
    );
    expect(mocks.tasks[1]?.result).toMatchObject({
      error: expect.stringContaining("cannot fork a session"),
    });
    expect(mocks.createLoop).toHaveBeenCalledTimes(1);
  });

  it("keeps the cancel reason when a cancel lands before the waiting note is written", async () => {
    mocks.busy = true;
    const cancelledResult = {
      cancelled: "ticket moved to Done",
      cancelledFrom: OrchestratorTaskStatus.Queued,
    };
    mocks.onBusyCheck = () => {
      const row = mocks.tasks[0];
      if (row) {
        row.status = OrchestratorTaskStatus.Cancelled;
        row.result = cancelledResult;
      }
    };

    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
    });

    expect(mocks.tasks[0]).toMatchObject({
      status: OrchestratorTaskStatus.Cancelled,
      result: cancelledResult,
    });
  });

  it("queues the task while a one-at-a-time runner is busy, and starts it on a later tick", async () => {
    mocks.busy = true;
    const started = await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
    });
    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Queued
    );
    expect(started.ok && started.value.waiting).toBe(
      "Waiting for an-PRO-1: busy."
    );
    expect(mocks.createLoop).not.toHaveBeenCalled();

    mocks.busy = false;
    mocks.settled = false;
    mocks.loops.set("loop-1", { status: LoopStatus.Running, revivalCount: 0 });
    const ticked = await advanceTasks(new Date());

    expect(ticked.launched).toBe(1);
    expect(mocks.tasks[0]?.status).toBe(OrchestratorTaskStatus.Running);
    expect(mocks.tasks[0]?.result).toMatchObject({ waiting: null });
  });

  it("fails the task at once when its runner is offline", async () => {
    mocks.online = false;

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Failed
    );
    expect(started.ok && started.value.error).toContain(
      "Runner runner-1 is offline"
    );
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("queues the task while another loop of the case's Issue runs on that runner", async () => {
    mocks.createLoop.mockRejectedValue(
      Object.assign(new Error("already active"), {
        code: WorkflowRunErrorCode.LoopAlreadyActive,
      })
    );

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Queued
    );
    expect(started.ok && started.value.waiting).toContain(
      "other task on runner-1"
    );
  });

  it("fails the task when its loop cannot be sent", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, error: "runner_offline" });

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Failed
    );
    expect(mocks.tasks[0]?.result).toMatchObject({
      error: expect.stringContaining("runner_offline"),
    });
  });
});

describe("advanceTasks", () => {
  it("wakes the wait of a queued task that fails on a later tick", async () => {
    mocks.busy = true;
    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
    });
    mocks.busy = false;
    mocks.online = false;

    const ticked = await advanceTasks(new Date());

    expect(mocks.tasks[0]?.status).toBe(OrchestratorTaskStatus.Failed);
    expect(ticked.settledConversationIds).toEqual([IDS.conversation]);
  });

  it("settles a finished task with the answer and questions its agent left", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.loops.set("loop-1", {
      status: LoopStatus.Completed,
      completedAt: new Date(),
      revivalCount: 0,
      error: null,
      uploadedArtifacts: {
        step: {
          stepId: "task-1",
          questions: [{ id: "q1", question: "Which policy version?" }],
          files: [
            {
              path: ORCHESTRATOR_TASK_REPLY_FILE,
              content: "Policy v3.1 §4: half days are allowed.",
              truncated: false,
            },
          ],
          questionsError: null,
        },
      },
    });

    const ticked = await advanceTasks(new Date());

    expect(ticked.settledConversationIds).toEqual([IDS.conversation]);
    expect(mocks.tasks[0]).toMatchObject({
      status: OrchestratorTaskStatus.Succeeded,
      result: {
        reply: "Policy v3.1 §4: half days are allowed.",
        questions: [{ id: "q1", question: "Which policy version?" }],
        error: null,
      },
    });
  });

  it("fails a task whose loop failed, with the loop's error", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.loops.set("loop-1", {
      status: LoopStatus.Failed,
      completedAt: new Date(),
      revivalCount: 0,
      error: { code: "x", message: "claude exited 1" },
      uploadedArtifacts: null,
    });

    await advanceTasks(new Date());

    expect(mocks.tasks[0]).toMatchObject({
      status: OrchestratorTaskStatus.Failed,
      result: { error: expect.stringContaining("claude exited 1") },
    });
  });

  it("leaves a task whose loop still runs", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.loops.set("loop-1", { status: LoopStatus.Running, revivalCount: 0 });
    mocks.settled = false;

    const ticked = await advanceTasks(new Date());

    expect(ticked.settledConversationIds).toEqual([]);
    expect(mocks.tasks[0]?.status).toBe(OrchestratorTaskStatus.Running);
  });
});

const SIBLING = "task-sibling";
const PRD_REF = { taskId: SIBLING, name: "PRD-LD-5.md" };

function addSibling(files: Row[]) {
  mocks.tasks.push({
    id: SIBLING,
    caseId: IDS.case,
    organizationId: IDS.org,
    loopId: "loop-sibling",
    result: { reply: null, questions: [], error: null, files },
  });
}

const PRD_KEY = `${IDS.org}/loops/loop-sibling/step-attachments/0-PRD-LD-5.md`;
const PRD_FILE = {
  name: "PRD-LD-5.md",
  size: 10,
  storageKey: PRD_KEY,
  skipped: null,
};

describe("task files", () => {
  it("hands a sibling task's text file to the launched step as an input", async () => {
    addSibling([PRD_FILE]);
    mocks.stored.set(PRD_KEY, new TextEncoder().encode("# PRD"));

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      files: [PRD_REF],
    });

    expect(started.ok).toBe(true);
    expect(mocks.tasks[1]?.result).toMatchObject({
      inputs: [{ taskId: SIBLING, name: "PRD-LD-5.md", storageKey: PRD_KEY }],
    });
    const call = mocks.createLoop.mock.calls[0]?.[2];
    expect(call.metadata.step.inputs).toEqual([
      { name: "PRD-LD-5.md", content: "# PRD" },
    ]);
    expect(call.prompt).toContain("inputs/");
    expect(call.prompt).toContain("PRD-LD-5.md");
  });

  it("refuses files of another case, unknown names and skipped files without creating a task", async () => {
    addSibling([
      PRD_FILE,
      { name: "a.png", size: 9, storageKey: null, skipped: "larger than 4 MB" },
    ]);
    mocks.tasks.push({ id: "other", caseId: "other-case", result: null });
    const start = (files: Array<{ taskId: string; name: string }>) =>
      startTask({
        ...BASE,
        runner: "runner-1",
        command: "/ba-requirement",
        files,
      });

    expect(await start([{ taskId: "other", name: "x.md" }])).toEqual({
      ok: false,
      error: "Task other is not a task of this case.",
    });
    expect(await start([{ taskId: SIBLING, name: "nope.md" }])).toEqual({
      ok: false,
      error: `Task ${SIBLING} has no file "nope.md" (its files: PRD-LD-5.md, a.png).`,
    });
    expect(await start([{ taskId: SIBLING, name: "a.png" }])).toEqual({
      ok: false,
      error: `File "a.png" of task ${SIBLING} was not collected: larger than 4 MB.`,
    });
    expect(mocks.tasks).toHaveLength(2);
  });

  it("refuses a binary file as an input", async () => {
    addSibling([PRD_FILE]);
    mocks.stored.set(PRD_KEY, new Uint8Array([0xff, 0xfe, 0x00, 0x80]));

    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      files: [PRD_REF],
    });

    expect(started).toEqual({
      ok: false,
      error:
        '"PRD-LD-5.md" is not a text file: only text files can be handed to a task.',
    });
  });

  it("adds a command's declared attach globs to the step and the prompt", async () => {
    mocks.baAttach = ["PRD-*.md"];

    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });

    const call = mocks.createLoop.mock.calls[0]?.[2];
    expect(call.metadata.step.attach).toEqual([".agentflow-ai/work/PRD-*.md"]);
    expect(call.prompt).toContain("PRD-*.md");
  });

  it("keeps a queued task's inputs and launches it with them later", async () => {
    addSibling([PRD_FILE]);
    mocks.stored.set(PRD_KEY, new TextEncoder().encode("# PRD"));
    mocks.busy = true;

    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
      files: [PRD_REF],
    });

    expect(mocks.tasks[1]).toMatchObject({
      status: OrchestratorTaskStatus.Queued,
      result: { waiting: expect.any(String), inputs: [expect.any(Object)] },
    });
    mocks.busy = false;
    await advanceTasks(new Date());
    expect(mocks.createLoop.mock.calls[0]?.[2].metadata.step.inputs).toEqual([
      { name: "PRD-LD-5.md", content: "# PRD" },
    ]);
  });

  it("settles a task with the files its step collected", async () => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    mocks.loops.set("loop-1", {
      status: LoopStatus.Completed,
      completedAt: new Date(),
      revivalCount: 0,
      error: null,
      uploadedArtifacts: {
        step: {
          stepId: "task-1",
          questions: [],
          files: [],
          questionsError: null,
          attachments: [
            {
              path: ".agentflow-ai/work/PRD-LD-5.md",
              size: 10,
              storageKey: "k",
            },
            {
              path: ".agentflow-ai/work/evidence-LD-5/a.png",
              size: 9,
              skipped: "larger than 4 MB",
            },
          ],
        },
      },
    });

    await advanceTasks(new Date());

    expect(mocks.tasks[0]?.result).toMatchObject({
      files: [
        { name: "PRD-LD-5.md", size: 10, storageKey: "k", skipped: null },
        {
          name: "evidence-LD-5/a.png",
          size: 9,
          storageKey: null,
          skipped: "larger than 4 MB",
        },
      ],
    });
  });
});

describe("buildTaskPrompt", () => {
  it("puts the command first, then the request and where to answer", () => {
    const prompt = buildTaskPrompt({
      command: "/ba-requirement",
      args: "LD-7",
      prompt: "What does the policy say?",
      mode: RunnerCommandMode.Read,
    });
    expect(
      prompt.startsWith("/ba-requirement LD-7\n\nWhat does the policy say?")
    ).toBe(true);
    expect(prompt).toContain(ORCHESTRATOR_TASK_REPLY_FILE);
    expect(prompt).toContain("This task only reads");
    expect(prompt).not.toContain("inputs/");
  });

  it("tells the agent where its attach files and inputs go", () => {
    const prompt = buildTaskPrompt(
      { command: "/qa-test", args: "LD-7", prompt: "Design", mode: "write" },
      { attach: ["TESTCASES-*.md"], inputs: ["PRD-LD-7.md"] }
    );
    expect(prompt).toContain("TESTCASES-*.md");
    expect(prompt).toContain("PRD-LD-7.md");
  });
});
