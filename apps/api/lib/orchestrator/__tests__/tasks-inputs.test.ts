import { LoopStatus } from "@repo/api/src/types/loop";
import { OrchestratorTaskStatus } from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  IDS,
  taskMocks as mocks,
  type Row,
  resetTaskMocks,
} from "@/lib/orchestrator/__tests__/support/tasks.test-fake";
import { advanceTasks, startTask } from "@/lib/orchestrator/tasks";

/**
 * Files an orchestrator task takes and leaves (inputs, attach globs,
 * collected files) and what survives when the task fails (docs/orchestrator.md).
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

  it("keeps a failed task's inputs when its loop failed", async () => {
    addSibling([PRD_FILE]);
    mocks.stored.set(PRD_KEY, new TextEncoder().encode("# PRD"));
    mocks.busy = true;
    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
      files: [PRD_REF],
    });
    mocks.busy = false;
    mocks.loops.set("loop-1", {
      status: LoopStatus.Failed,
      completedAt: new Date(),
      revivalCount: 0,
      error: { code: "x", message: "claude exited 426" },
      uploadedArtifacts: null,
    });

    await advanceTasks(new Date());

    expect(mocks.tasks[1]).toMatchObject({
      status: OrchestratorTaskStatus.Failed,
      result: {
        inputs: [expect.any(Object)],
        error: expect.stringContaining("claude exited 426"),
      },
    });
  });

  it("keeps a queued task's inputs when it fails to launch", async () => {
    addSibling([PRD_FILE]);
    mocks.stored.set(PRD_KEY, new TextEncoder().encode("# PRD"));
    mocks.dispatch.mockResolvedValue({ ok: false, error: "runner_offline" });

    await startTask({
      ...BASE,
      runner: "an-PRO-1",
      command: "/executing-plans",
      files: [PRD_REF],
    });

    expect(mocks.tasks[1]).toMatchObject({
      status: OrchestratorTaskStatus.Failed,
      result: {
        inputs: [expect.any(Object)],
        error: expect.stringContaining("runner_offline"),
      },
    });
  });

  it.each([
    [LoopStatus.Completed, OrchestratorTaskStatus.Succeeded],
    [LoopStatus.Failed, OrchestratorTaskStatus.Failed],
  ])("keeps the message a task answers when its loop %s", async (loop, status) => {
    await startTask({
      ...BASE,
      runner: "runner-1",
      command: "/ba-requirement",
      replyTo: "10500",
    });
    expect(mocks.tasks[0]?.result).toMatchObject({ replyTo: "10500" });
    mocks.loops.set("loop-1", {
      status: loop,
      completedAt: new Date(),
      revivalCount: 0,
      error:
        loop === LoopStatus.Failed ? { code: "x", message: "exit 1" } : null,
      uploadedArtifacts: {
        step: { stepId: "task-1", questions: [], files: [] },
      },
    });

    await advanceTasks(new Date());

    expect(mocks.tasks[0]).toMatchObject({
      status,
      result: { replyTo: "10500" },
    });
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
