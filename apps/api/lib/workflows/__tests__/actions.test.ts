import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import {
  type ActionRunsDbFake,
  createActionRunsDbFake,
  type FakeRow,
} from "@/lib/workflows/__tests__/support/action-runs-db.test-fake";
import {
  ACTION_MAX_ATTEMPTS,
  ACTION_RUNNING_STALE_MS,
  drainActionRuns,
  enqueueRunEvents,
  hasEnabledPreActions,
  requeueStaleActionRuns,
  retryDelayMs,
  skipUnfinishedPreActionRuns,
} from "@/lib/workflows/engine/actions";

const mocks = vi.hoisted(() => ({
  fake: null as ActionRunsDbFake | null,
  execute: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  buildRunSnapshot: vi.fn(),
  recordActionOutputs: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (client: unknown) => unknown) => fn(mocks.fake?.db),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
  createProviderContext: (runtime: unknown) => ({
    connection: runtime,
    http: {},
    log: {},
    now: () => new Date(),
  }),
}));
vi.mock("@/lib/integrations/registry", () => ({
  findActionDefinition: (_provider: string, type: string) =>
    type === ACTION_TYPE
      ? {
          key: ACTION_TYPE,
          configSchema: z.object({ message: z.string().min(1) }),
          execute: mocks.execute,
        }
      : null,
}));
vi.mock("@/lib/workflows/engine/snapshot", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/snapshot")>();
  return { ...original, buildRunSnapshot: mocks.buildRunSnapshot };
});
vi.mock("@/lib/workflows/engine/run-repository", () => ({
  recordActionOutputs: mocks.recordActionOutputs,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const ACTION_TYPE = "fake.add_comment";
const ORG_ID = "org-1";
const RUN_ID = "run-1";
const WORKFLOW_ID = "workflow-1";
const SECRET = "pat-secret-value-1234";
const NOW = new Date("2026-10-01T12:00:00.000Z");

let fake: ActionRunsDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createActionRunsDbFake();
  mocks.fake = fake;
  fake.addAction({
    id: "action-1",
    type: ACTION_TYPE,
    config: { message: "{{ summary }} ({{source.key}})" },
    events: [WorkflowRunEvent.Succeeded],
  });
  mocks.loadConnectionRuntime.mockResolvedValue(connection());
  mocks.buildRunSnapshot.mockResolvedValue(snapshot());
  mocks.execute.mockResolvedValue({
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: "comment-42",
  } satisfies ActionResult);
});

function connection(status: string = IntegrationConnectionStatus.Active) {
  return {
    record: { id: "conn-1", name: "Jira", status },
    provider: { key: "fake", displayName: "Fake" },
    runtime: { id: "conn-1", secrets: { pat: SECRET }, config: {} },
  };
}

function snapshot(): WorkflowRunSnapshot {
  return {
    id: RUN_ID,
    url: "https://app.test/acme/workflows/w/runs/run-1",
    status: WorkflowRunStatus.Succeeded,
    event: WorkflowRunEvent.Succeeded,
    workflow: { id: "w", name: "Flow" },
    trigger: null,
    source: {
      provider: "fake",
      externalId: "1",
      key: "PROJ-7",
      url: null,
      title: "Title",
      container: null,
    },
    sourceExtras: {},
    feature: null,
    plan: null,
    pullRequest: null,
    pullRequests: [],
    repositories: [],
    repository: null,
    error: null,
    step: null,
    reply: null,
    documents: [],
    stepReplies: {},
    summaryMarkdown: "Done!",
    startedAt: NOW.toISOString(),
    completedAt: null,
  } as WorkflowRunSnapshot;
}

function addActionRun(overrides: Partial<FakeRow> = {}): FakeRow {
  return fake.addActionRun({
    organizationId: ORG_ID,
    runId: RUN_ID,
    actionId: "action-1",
    actionType: ACTION_TYPE,
    nextAttemptAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  });
}

function drain() {
  return drainActionRuns({ now: NOW });
}

/** [actionRunId, attempt] of every execute call, in order. */
function executions(): [string, number][] {
  return mocks.execute.mock.calls.map((call) => {
    const context = call[0] as ActionContext<unknown, unknown, unknown>;
    return [context.actionRunId, context.attempt];
  });
}

function runTarget(cycle = 1) {
  return { id: RUN_ID, organizationId: ORG_ID, workflowId: WORKFLOW_ID, cycle };
}

describe("drainActionRuns", () => {
  beforeEach(() => {
    // Backoff is computed from the time the attempt settles.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes the action with parsed config, snapshot and renderer", async () => {
    const row = addActionRun();

    const counts = await drain();

    expect(counts).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(row).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      attempts: 1,
      externalRef: "comment-42",
      lastError: null,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
    const context = mocks.execute.mock.calls[0][0] as ActionContext<
      { message: string },
      unknown,
      unknown
    >;
    expect(context.config).toEqual({
      message: "{{ summary }} ({{source.key}})",
    });
    expect(context.run.id).toBe(RUN_ID);
    expect(context.render(context.config.message)).toBe("Done! (PROJ-7)");
    expect(mocks.buildRunSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      WorkflowRunEvent.Succeeded
    );
  });

  it("records the action's outputs on the run before settling the row", async () => {
    const row = addActionRun();
    const outputs = {
      pullRequests: [
        {
          repositoryId: "0199a5f0-0000-7000-8000-0000000000f1",
          url: "https://github.com/acme/app/pull/9",
          number: 9,
          branch: "feat/proj-7",
        },
      ],
    };
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "https://github.com/acme/app/pull/9",
      outputs,
    } satisfies ActionResult);
    let statusWhenRecorded: unknown = null;
    mocks.recordActionOutputs.mockImplementationOnce(() => {
      statusWhenRecorded = row.status;
      return Promise.resolve();
    });

    await drain();

    expect(mocks.recordActionOutputs).toHaveBeenCalledWith(RUN_ID, outputs);
    expect(statusWhenRecorded).toBe(WorkflowActionRunStatus.Running);
    expect(row.status).toBe(WorkflowActionRunStatus.Succeeded);
  });

  it("records the outputs of a failed attempt, and none of a skipped one", async () => {
    addActionRun();
    const outputs = {
      pullRequests: [
        {
          repositoryId: "0199a5f0-0000-7000-8000-0000000000f1",
          url: "https://github.com/acme/app/pull/9",
          number: 9,
          branch: "feat/proj-7",
        },
      ],
    };
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Failed,
      error: "acme/api: boom",
      retryable: false,
      outputs,
    } satisfies ActionResult);

    await drain();

    expect(mocks.recordActionOutputs).toHaveBeenCalledWith(RUN_ID, outputs);

    mocks.recordActionOutputs.mockClear();
    addActionRun();
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Skipped,
      reason: "nothing to do",
    } satisfies ActionResult);

    await drain();

    expect(mocks.recordActionOutputs).not.toHaveBeenCalled();
  });

  it("passes the stable action run id and the 1-based attempt number", async () => {
    const row = addActionRun({ attempts: 2 });

    await drain();

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionRunId: row.id, attempt: 3 })
    );
  });

  it("retries a retryable failure with backoff and scrubs secrets", async () => {
    const row = addActionRun();
    mocks.execute.mockResolvedValue({
      status: WorkflowActionRunStatus.Failed,
      error: `HTTP 503 calling https://x.test?token=${SECRET}`,
      retryable: true,
    });

    const counts = await drain();

    expect(counts).toMatchObject({ claimed: 1, retried: 1 });
    expect(row.status).toBe(WorkflowActionRunStatus.Pending);
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(row.lastError).toContain("HTTP 503");
    expect(row.lastError).not.toContain(SECRET);
  });

  it("backs off longer on later attempts", async () => {
    const row = addActionRun({ attempts: 2 });
    mocks.execute.mockResolvedValue({
      status: WorkflowActionRunStatus.Failed,
      error: "HTTP 429",
      retryable: true,
    });

    await drain();

    expect(row.attempts).toBe(3);
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
  });

  it("fails for good after the last attempt", async () => {
    const row = addActionRun({ attempts: ACTION_MAX_ATTEMPTS - 1 });
    mocks.execute.mockResolvedValue({
      status: WorkflowActionRunStatus.Failed,
      error: "HTTP 500",
      retryable: true,
    });

    const counts = await drain();

    expect(counts.failed).toBe(1);
    expect(row).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      attempts: ACTION_MAX_ATTEMPTS,
      lastError: "HTTP 500",
    });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("does not retry a non-retryable failure", async () => {
    const row = addActionRun();
    mocks.execute.mockResolvedValue({
      status: WorkflowActionRunStatus.Failed,
      error: "HTTP 404",
      retryable: false,
    });

    await drain();

    expect(row.status).toBe(WorkflowActionRunStatus.Failed);
  });

  it("records a skip reported by the action", async () => {
    const row = addActionRun();
    mocks.execute.mockResolvedValue({
      status: WorkflowActionRunStatus.Skipped,
      reason: "The run's source is not a Jira issue",
    });

    const counts = await drain();

    expect(counts.skipped).toBe(1);
    expect(row).toMatchObject({
      status: WorkflowActionRunStatus.Skipped,
      lastError: "The run's source is not a Jira issue",
    });
  });

  it("skips a row whose action was removed", async () => {
    const row = addActionRun({ actionId: null });

    await drain();

    expect(row.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("skips when the connection is disabled or gone", async () => {
    const disabled = addActionRun();
    mocks.loadConnectionRuntime.mockResolvedValueOnce(
      connection(IntegrationConnectionStatus.Disabled)
    );
    const gone = addActionRun({ runId: "run-2" });
    mocks.loadConnectionRuntime.mockResolvedValueOnce(null);

    await drain();

    expect(disabled.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(String(disabled.lastError)).toContain("disabled");
    expect(gone.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("skips when the stored config no longer parses", async () => {
    fake.actions[0].config = { message: "" };
    const row = addActionRun();

    await drain();

    expect(row.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("treats a throwing action as a retryable failure", async () => {
    const row = addActionRun();
    mocks.execute.mockRejectedValue(new Error("bug"));

    await drain();

    expect(row.status).toBe(WorkflowActionRunStatus.Pending);
    expect(row.attempts).toBe(1);
  });

  it("does not execute a row another worker claimed", async () => {
    addActionRun();
    fake.db.workflowActionRun.updateManyAndReturn.mockResolvedValueOnce([]);

    const counts = await drain();

    expect(counts.claimed).toBe(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("leaves the later rows of a run alone when an earlier one is claimed elsewhere", async () => {
    fake.addAction({
      id: "action-2",
      type: ACTION_TYPE,
      config: { message: "second" },
      position: 1,
    });
    addActionRun();
    const second = addActionRun({ actionId: "action-2" });
    // Another drain claimed row 1 between this drain's read and its claim.
    fake.db.workflowActionRun.updateManyAndReturn.mockResolvedValueOnce([]);

    const counts = await drain();

    expect(counts.claimed).toBe(0);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      status: WorkflowActionRunStatus.Pending,
      attempts: 0,
    });
  });

  it("does not re-run a row an overlapping drain rescheduled, and stops that run's rows", async () => {
    fake.addAction({
      id: "action-2",
      type: ACTION_TYPE,
      config: { message: "second" },
      position: 1,
    });
    const first = addActionRun();
    const second = addActionRun({ actionId: "action-2" });
    let overlapping: Promise<unknown> | null = null;
    mocks.execute.mockImplementation(
      async (context: ActionContext<unknown, unknown, unknown>) => {
        if (context.actionRunId === first.id && !overlapping) {
          // A second drain starts while this one is still executing row 1.
          overlapping = drain();
          await overlapping;
          return { status: WorkflowActionRunStatus.Succeeded };
        }
        return {
          status: WorkflowActionRunStatus.Failed,
          error: "HTTP 503",
          retryable: true,
        };
      }
    );

    await drain();

    // The overlapping drain ran row 2 once and scheduled its retry; the first
    // drain must not run it again before that time.
    expect(executions()).toEqual([
      [first.id, 1],
      [second.id, 1],
    ]);
    expect(first.status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(second).toMatchObject({
      status: WorkflowActionRunStatus.Pending,
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
  });

  it("passes the attempt number stored when the row is claimed", async () => {
    fake.addAction({
      id: "action-2",
      type: ACTION_TYPE,
      config: { message: "second" },
      position: 1,
    });
    const first = addActionRun();
    const second = addActionRun({ actionId: "action-2" });
    mocks.execute.mockImplementation(
      (context: ActionContext<unknown, unknown, unknown>) => {
        if (context.actionRunId === first.id) {
          // Meanwhile another worker tried row 2 twice and put it back.
          second.attempts = 2;
        }
        return Promise.resolve({ status: WorkflowActionRunStatus.Succeeded });
      }
    );

    await drain();

    expect(executions()).toEqual([
      [first.id, 1],
      [second.id, 3],
    ]);
    expect(second.attempts).toBe(3);
  });

  it("leaves rows that are not due yet", async () => {
    addActionRun({ nextAttemptAt: new Date(NOW.getTime() + 1000) });

    const counts = await drain();

    expect(counts.claimed).toBe(0);
  });

  it("never touches pre action rows (the run state machine runs them)", async () => {
    const pre = addActionRun({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
    });

    const counts = await drain();

    expect(counts.claimed).toBe(0);
    expect(pre.status).toBe(WorkflowActionRunStatus.Pending);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("enqueueRunEvents", () => {
  it("inserts one pending post row per subscribed action and event", async () => {
    fake.addAction({
      id: "action-2",
      type: ACTION_TYPE,
      events: [WorkflowRunEvent.Started, WorkflowRunEvent.Failed],
      position: 1,
    });

    const inserted = await enqueueRunEvents(runTarget(2), [
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.Succeeded,
    ]);

    expect(inserted).toBe(1);
    expect(fake.actionRuns).toEqual([
      expect.objectContaining({
        actionId: "action-1",
        stage: WorkflowActionStage.Post,
        event: WorkflowRunEvent.Succeeded,
        cycle: 2,
        status: WorkflowActionRunStatus.Pending,
      }),
    ]);
  });

  it("enqueues run.triggered for the enabled pre actions only", async () => {
    fake.addAction({
      id: "pre-1",
      type: ACTION_TYPE,
      stage: WorkflowActionStage.Pre,
      events: [WorkflowRunEvent.Triggered],
    });
    fake.addAction({
      id: "pre-off",
      type: ACTION_TYPE,
      stage: WorkflowActionStage.Pre,
      events: [WorkflowRunEvent.Triggered],
      enabled: false,
    });

    const inserted = await enqueueRunEvents(runTarget(3), [
      WorkflowRunEvent.Triggered,
    ]);

    expect(inserted).toBe(1);
    expect(fake.actionRuns).toEqual([
      expect.objectContaining({
        actionId: "pre-1",
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        cycle: 3,
      }),
    ]);
  });

  it("is idempotent per (run, action, event, cycle)", async () => {
    await enqueueRunEvents(runTarget(), [WorkflowRunEvent.Succeeded]);
    const again = await enqueueRunEvents(runTarget(), [
      WorkflowRunEvent.Succeeded,
    ]);

    expect(again).toBe(0);
    expect(fake.actionRuns).toHaveLength(1);
  });

  it("does nothing without events", async () => {
    await expect(enqueueRunEvents(runTarget(), [])).resolves.toBe(0);
  });

  it("makes the rows due at the given transition time", async () => {
    const transitionAt = new Date("2026-10-01T11:00:00.000Z");

    await enqueueRunEvents(
      runTarget(),
      [WorkflowRunEvent.Succeeded],
      transitionAt
    );

    expect(fake.actionRuns[0].nextAttemptAt).toEqual(transitionAt);
  });
});

describe("hasEnabledPreActions", () => {
  it("is true only for an enabled pre action of the workflow", async () => {
    const target = { organizationId: "org-1", workflowId: WORKFLOW_ID };
    await expect(hasEnabledPreActions(target)).resolves.toBe(false);

    fake.addAction({
      id: "pre-off",
      stage: WorkflowActionStage.Pre,
      enabled: false,
    });
    await expect(hasEnabledPreActions(target)).resolves.toBe(false);

    fake.addAction({ id: "pre-on", stage: WorkflowActionStage.Pre });
    await expect(hasEnabledPreActions(target)).resolves.toBe(true);
  });
});

describe("requeueStaleActionRuns", () => {
  it("requeues stale running post rows and fails exhausted ones", async () => {
    const stale = new Date(NOW.getTime() - ACTION_RUNNING_STALE_MS - 1);
    const requeued = addActionRun({
      status: WorkflowActionRunStatus.Running,
      attempts: 2,
      updatedAt: stale,
    });
    const exhausted = addActionRun({
      status: WorkflowActionRunStatus.Running,
      attempts: ACTION_MAX_ATTEMPTS,
      updatedAt: stale,
    });
    const fresh = addActionRun({
      status: WorkflowActionRunStatus.Running,
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - 1000),
    });
    const pre = addActionRun({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
      status: WorkflowActionRunStatus.Running,
      attempts: 1,
      updatedAt: stale,
    });

    const total = await requeueStaleActionRuns(NOW);

    expect(total).toBe(2);
    expect(requeued).toMatchObject({
      status: WorkflowActionRunStatus.Pending,
      nextAttemptAt: NOW,
    });
    expect(exhausted.status).toBe(WorkflowActionRunStatus.Failed);
    expect(fresh.status).toBe(WorkflowActionRunStatus.Running);
    expect(pre.status).toBe(WorkflowActionRunStatus.Running);
  });

  it("requeues the stale pre rows of one run when asked", async () => {
    const stale = new Date(NOW.getTime() - ACTION_RUNNING_STALE_MS - 1);
    const pre = addActionRun({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
      status: WorkflowActionRunStatus.Running,
      attempts: 1,
      updatedAt: stale,
    });

    await requeueStaleActionRuns(NOW, {
      runId: RUN_ID,
      stage: WorkflowActionStage.Pre,
    });

    expect(pre.status).toBe(WorkflowActionRunStatus.Pending);
  });
});

describe("skipUnfinishedPreActionRuns", () => {
  it("skips the cycle's pending and running pre rows only", async () => {
    const pending = addActionRun({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
    });
    const done = addActionRun({
      actionId: "action-2",
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
      status: WorkflowActionRunStatus.Succeeded,
    });
    const post = addActionRun();
    const otherCycle = addActionRun({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
      cycle: 2,
    });

    const skipped = await skipUnfinishedPreActionRuns(
      { id: RUN_ID, cycle: 1 },
      "The run stopped."
    );

    expect(skipped).toBe(1);
    expect(pending).toMatchObject({
      status: WorkflowActionRunStatus.Skipped,
      lastError: "The run stopped.",
    });
    expect(done.status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(post.status).toBe(WorkflowActionRunStatus.Pending);
    expect(otherCycle.status).toBe(WorkflowActionRunStatus.Pending);
  });
});

describe("retryDelayMs", () => {
  it("follows 30s, 2m, 10m, 30m and stops at the attempt limit", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([
      30_000,
      120_000,
      600_000,
      1_800_000,
      null,
    ]);
  });
});
