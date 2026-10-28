import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ORCHESTRATOR_TASK_REPLY_FILE,
  OrchestratorTaskStatus,
} from "@repo/api/src/types/orchestrator";
import { RunnerCommandMode } from "@repo/api/src/types/runner-capabilities";
import { WorkflowRunErrorCode } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  IDS,
  taskMocks as mocks,
  resetTaskMocks,
} from "@/lib/orchestrator/__tests__/support/tasks.test-fake";
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

vi.mock("@repo/database", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).databaseModule()
);
vi.mock("@/app/compute-targets/capabilities-service", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).capabilitiesModule()
);
vi.mock("@/lib/loops/loop-state", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).loopStateModule()
);
vi.mock("@/app/documents/document-service", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).documentServiceModule()
);
vi.mock("@/app/loops/service", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).loopsServiceModule()
);
vi.mock("@/app/projects/project-repository-checkouts", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).checkoutsModule()
);
vi.mock("@/lib/loops/launch-harness", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).launchHarnessModule()
);
vi.mock("@/lib/loops/loop-dispatch-utils", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).dispatchUtilsModule()
);
vi.mock("@/lib/workflows/engine/launch", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).engineLaunchModule()
);
vi.mock("@/lib/workflows/engine/personal-runner-queue", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).personalRunnerQueueModule()
);
vi.mock("@/lib/workflows/engine/run-loops", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).runLoopsModule()
);
vi.mock("@/lib/orchestrator/case-render", async () =>
  (
    await import("@/lib/orchestrator/__tests__/support/tasks.test-fake")
  ).caseRenderModule()
);

beforeEach(resetTaskMocks);

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
        replyTo: null,
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

  it("refuses a command the runner does not declare, and creates no task", async () => {
    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/qa-test",
    });

    expect(!started.ok && started.error).toContain(
      "is not declared in runner-1's AGENTFLOW.md"
    );
    expect(!started.ok && started.error).toContain("/ba-requirement");
    expect(mocks.tasks).toHaveLength(0);
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("refuses write mode for a read command", async () => {
    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      mode: RunnerCommandMode.Write,
    });

    expect(!started.ok && started.error).toContain("mode: read");
    expect(mocks.tasks).toHaveLength(0);
  });

  it("runs a write command read-only when asked", async () => {
    const started = await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
      mode: RunnerCommandMode.Read,
    });

    expect(started.ok).toBe(true);
    expect(mocks.createLoop.mock.calls[0]?.[2].metadata.step.readOnly).toBe(
      true
    );
    expect(mocks.tasks[0]?.mode).toBe(RunnerCommandMode.Read);
  });

  it("fails a queued task at launch when its command is no longer declared", async () => {
    mocks.busy = true;
    const started = await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
    });
    expect(started.ok && started.value.status).toBe(
      OrchestratorTaskStatus.Queued
    );

    mocks.busy = false;
    mocks.dropBaCommand = true;
    await advanceTasks(new Date());

    expect(mocks.tasks[0]?.status).toBe(OrchestratorTaskStatus.Failed);
    expect(mocks.tasks[0]?.result).toMatchObject({
      error: expect.stringContaining("not declared"),
    });
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
