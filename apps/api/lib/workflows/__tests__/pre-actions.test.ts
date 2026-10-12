import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  SourceItem,
  WorkflowRunSnapshot,
} from "@/lib/integrations/types";
import type { FakeRow } from "@/lib/workflows/__tests__/support/action-runs-db.test-fake";
import {
  type AdvanceDbFake,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  ORG_ID,
  PLAN_DOCUMENT_ID,
  RUN_ID,
  WORKFLOW_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { ACTION_RUNNING_STALE_MS } from "@/lib/workflows/engine/actions";
import { advanceRun, cancelRun } from "@/lib/workflows/engine/advance";

/**
 * The pre_actions phase end to end: advance.ts + phases.ts + pre-actions.ts
 * with the real action executor (actions.ts) over in-memory rows. Only the
 * provider action, the connection, the snapshot and the agent-team launch are
 * faked.
 */

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  /** Wall-clock milliseconds every database call takes (0: time stands still). */
  dbCallMs: 0,
  execute: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  buildRunSnapshot: vi.fn(),
  launchWorkflowLoop: vi.fn(),
  ensureRunDocuments: vi.fn(),
  findLatestRunLoop: vi.fn(),
  cancelRunLoops: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/advance-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) => {
    if (mocks.dbCallMs > 0) {
      vi.setSystemTime(Date.now() + mocks.dbCallMs);
    }
    return fn(mocks.fake?.db);
  };
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb, Prisma: { DbNull: support.PRISMA_DB_NULL } };
});
vi.mock("@/lib/integrations/registry", () => ({
  findActionDefinition: (_provider: string, type: string) =>
    type === ACTION_TYPE
      ? {
          key: ACTION_TYPE,
          displayName: ACTION_DISPLAY_NAME,
          configSchema: z.object({ name: z.string() }),
          execute: mocks.execute,
        }
      : null,
  listIntegrationProviders: () => [
    {
      key: "fake",
      actions: [{ key: ACTION_TYPE, displayName: ACTION_DISPLAY_NAME }],
    },
  ],
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
vi.mock("@/lib/workflows/engine/snapshot", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/snapshot")>();
  return { ...original, buildRunSnapshot: mocks.buildRunSnapshot };
});
vi.mock("@/lib/workflows/engine/launch", () => ({
  launchWorkflowLoop: mocks.launchWorkflowLoop,
}));
// Agent steps launch STEP loops; the built-in flow never does.
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/documents", () => ({
  ensureRunDocuments: mocks.ensureRunDocuments,
  approvePlanDocument: vi.fn(),
  markIssueInReview: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-loops")>();
  return {
    ...original,
    findLatestRunLoop: mocks.findLatestRunLoop,
    findAdoptableLoop: vi.fn(),
    recordRunLoop: vi.fn(),
  };
});
vi.mock("@/app/loops/service", () => ({ loopsService: { findById: vi.fn() } }));
vi.mock("@/lib/workflows/engine/cancel", () => ({
  cancelRunLoops: mocks.cancelRunLoops,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const ACTION_TYPE = "fake.transition_issue";
const ACTION_DISPLAY_NAME = "Transition issue";
const NOW = new Date("2026-10-01T01:00:00.000Z");
const SOURCE_ITEM: SourceItem = {
  provider: "fake",
  externalId: "1",
  key: "PROJ-7",
  url: null,
  title: "Add CSV export",
  container: null,
  bodyMarkdown: "body",
  itemType: null,
  status: null,
  priority: null,
  labels: [],
  reporter: null,
  assignee: null,
  sections: [],
  comments: [],
  attachments: [],
};

let fake: AdvanceDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbCallMs = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  mocks.loadConnectionRuntime.mockResolvedValue({
    record: {
      id: "conn-1",
      name: "Jira",
      status: IntegrationConnectionStatus.Active,
    },
    provider: {
      key: "fake",
      displayName: "Fake",
      source: { fetchItem: () => Promise.resolve(SOURCE_ITEM) },
    },
    runtime: { id: "conn-1", secrets: {}, config: {} },
  });
  mocks.buildRunSnapshot.mockImplementation(
    (runId: string, event: WorkflowRunEvent) =>
      Promise.resolve(snapshot(runId, event))
  );
  mocks.execute.mockResolvedValue({
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: "ok",
  } satisfies ActionResult);
  mocks.ensureRunDocuments.mockResolvedValue(
    Result.ok({
      featureDocumentId: FEATURE_DOCUMENT_ID,
      planDocumentId: PLAN_DOCUMENT_ID,
    })
  );
  // No PLAN loop of the ingesting phase yet; the launched one is running.
  mocks.findLatestRunLoop.mockImplementation(
    (_runId: string, _command: string, since?: Date) =>
      Promise.resolve(since ? null : { status: LoopStatus.Running })
  );
  mocks.launchWorkflowLoop.mockResolvedValue(
    Result.ok({ loopId: "loop-1", computeTargetId: "ct-1" })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function run() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

function snapshot(runId: string, event: WorkflowRunEvent): WorkflowRunSnapshot {
  return {
    id: runId,
    url: "https://app.test/acme/workflows/w/runs/run-1",
    status: WorkflowRunStatus.PreActions,
    event,
    workflow: { id: WORKFLOW_ID, name: "Jira to PR" },
    trigger: null,
    source: SOURCE_ITEM,
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
    summaryMarkdown: "received",
    startedAt: NOW.toISOString(),
    completedAt: null,
  };
}

function addPreAction(
  id: string,
  position: number,
  overrides: Partial<FakeRow> = {}
): FakeRow {
  return fake.actionDb.addAction({
    id,
    organizationId: ORG_ID,
    workflowId: WORKFLOW_ID,
    type: ACTION_TYPE,
    config: { name: id },
    stage: WorkflowActionStage.Pre,
    events: [WorkflowRunEvent.Triggered],
    position,
    ...overrides,
  });
}

function addPreActionRun(overrides: Partial<FakeRow> = {}): FakeRow {
  return fake.actionDb.addActionRun({
    organizationId: ORG_ID,
    runId: RUN_ID,
    actionType: ACTION_TYPE,
    stage: WorkflowActionStage.Pre,
    event: WorkflowRunEvent.Triggered,
    ...overrides,
  });
}

function preRow(actionId: string): FakeRow {
  const row = fake.actionDb.actionRuns.find(
    (entry) =>
      entry.actionId === actionId && entry.stage === WorkflowActionStage.Pre
  );
  if (!row) {
    throw new Error(`pre row for ${actionId} expected`);
  }
  return row;
}

function executed(): Array<{
  name: string;
  actionRunId: string;
  attempt: number;
}> {
  return mocks.execute.mock.calls.map((call) => {
    const context = call[0] as ActionContext<
      { name: string },
      unknown,
      unknown
    >;
    return {
      name: context.config.name,
      actionRunId: context.actionRunId,
      attempt: context.attempt,
    };
  });
}

function at(offsetMs: number): Date {
  const date = new Date(NOW.getTime() + offsetMs);
  vi.setSystemTime(date);
  return date;
}

describe("pre actions", () => {
  it("goes straight to the agent team when the workflow has none", async () => {
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(fake.actionDb.actionRuns).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("runs them inline in position order, then ingests in the same call", async () => {
    addPreAction("pre-b", 1);
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(executed()).toEqual([
      { name: "pre-a", actionRunId: preRow("pre-a").id, attempt: 1 },
      { name: "pre-b", actionRunId: preRow("pre-b").id, attempt: 1 },
    ]);
    expect(preRow("pre-a")).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      cycle: 1,
      externalRef: "ok",
    });
    expect(preRow("pre-b").status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(mocks.buildRunSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      WorkflowRunEvent.Triggered
    );
    expect(mocks.ensureRunDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledTimes(1);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(run().leaseUntil).toBeNull();
  });

  it("runs them inline on a new run's first advance even when time passes between enqueue and execution", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.Received });
    // Every query takes a millisecond, like a real database round trip, so
    // the rows are written after the advance's start time.
    mocks.dbCallMs = 1;

    await advanceRun(RUN_ID);

    expect(executed()).toEqual([
      { name: "pre-a", actionRunId: preRow("pre-a").id, attempt: 1 },
    ]);
    expect(preRow("pre-a").status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("stops while a pre action waits for its backoff and resumes on a later advance", async () => {
    addPreAction("pre-a", 0);
    addPreAction("pre-b", 1);
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Failed,
      error: "HTTP 503",
      retryable: true,
    });
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.PreActions);
    expect(preRow("pre-a")).toMatchObject({
      status: WorkflowActionRunStatus.Pending,
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
      lastError: "HTTP 503",
    });
    expect(preRow("pre-b").status).toBe(WorkflowActionRunStatus.Pending);
    expect(mocks.ensureRunDocuments).not.toHaveBeenCalled();

    // A tick before the backoff elapsed changes nothing.
    await advanceRun(RUN_ID, at(10_000));
    expect(executed()).toHaveLength(1);

    await advanceRun(RUN_ID, at(31_000));

    expect(executed().map((call) => [call.name, call.attempt])).toEqual([
      ["pre-a", 1],
      ["pre-a", 2],
      ["pre-b", 1],
    ]);
    expect(preRow("pre-a").status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("fails the run with pre_action_failed, skips the rest and enqueues run.failed", async () => {
    addPreAction("pre-a", 0);
    addPreAction("pre-b", 1);
    fake.actionDb.addAction({
      id: "notify",
      organizationId: ORG_ID,
      workflowId: WORKFLOW_ID,
      type: ACTION_TYPE,
      config: { name: "notify" },
      stage: WorkflowActionStage.Post,
      events: [WorkflowRunEvent.Failed],
    });
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Failed,
      error: 'No transition named "In Progress"',
      retryable: false,
    });
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);
    // The run.failed post action is drained in the background.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    await mocks.waitUntil.mock.calls[0][0];

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toEqual({
      code: WorkflowRunErrorCode.PreActionFailed,
      message: `Pre action ${ACTION_DISPLAY_NAME} failed: No transition named "In Progress"`,
    });
    expect(run().completedAt).toEqual(NOW);
    expect(executed().map((call) => call.name)).toEqual(["pre-a", "notify"]);
    expect(preRow("pre-a").status).toBe(WorkflowActionRunStatus.Failed);
    expect(preRow("pre-b")).toMatchObject({
      status: WorkflowActionRunStatus.Skipped,
      lastError: "The run stopped before this pre action ran.",
    });
    expect(
      fake.actionDb.actionRuns.filter(
        (row) => row.stage === WorkflowActionStage.Post
      )
    ).toEqual([
      expect.objectContaining({
        actionId: "notify",
        event: WorkflowRunEvent.Failed,
        cycle: 1,
        status: WorkflowActionRunStatus.Succeeded,
      }),
    ]);
    expect(mocks.buildRunSnapshot).toHaveBeenLastCalledWith(
      RUN_ID,
      WorkflowRunEvent.Failed
    );
    expect(mocks.ensureRunDocuments).not.toHaveBeenCalled();
  });

  it("falls back to the action type when the registry no longer knows it", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    const row = addPreActionRun({
      actionId: "pre-a",
      actionType: "gone.action",
      status: WorkflowActionRunStatus.Failed,
      lastError: "HTTP 500",
    });

    await advanceRun(RUN_ID, NOW);

    expect(row.status).toBe(WorkflowActionRunStatus.Failed);
    expect(run().error).toMatchObject({
      message: "Pre action gone.action failed: HTTP 500",
    });
  });

  it("continues past a failed pre action marked continueOnError", async () => {
    addPreAction("pre-a", 0, { continueOnError: true });
    addPreAction("pre-b", 1);
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Failed,
      error: "HTTP 404",
      retryable: false,
    });
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(preRow("pre-a").status).toBe(WorkflowActionRunStatus.Failed);
    expect(executed().map((call) => call.name)).toEqual(["pre-a", "pre-b"]);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("counts skipped pre actions as done, including removed actions", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    const removed = addPreActionRun({ actionId: null });
    addPreActionRun({ actionId: "pre-a" });
    mocks.execute.mockResolvedValueOnce({
      status: WorkflowActionRunStatus.Skipped,
      reason: "The run's source is not a Jira issue",
    });

    await advanceRun(RUN_ID, NOW);

    expect(preRow("pre-a").status).toBe(WorkflowActionRunStatus.Skipped);
    expect(removed).toMatchObject({
      status: WorkflowActionRunStatus.Skipped,
      lastError: "The action was removed from the workflow.",
    });
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("retries a pre action left running by a worker that died", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    addPreActionRun({
      actionId: "pre-a",
      status: WorkflowActionRunStatus.Running,
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - ACTION_RUNNING_STALE_MS - 1),
    });

    await advanceRun(RUN_ID, NOW);

    expect(executed()).toEqual([
      expect.objectContaining({ name: "pre-a", attempt: 2 }),
    ]);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("waits while a pre action is running elsewhere", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    addPreActionRun({
      actionId: "pre-a",
      status: WorkflowActionRunStatus.Running,
      attempts: 1,
      updatedAt: new Date(NOW.getTime() - 60_000),
    });

    await advanceRun(RUN_ID, NOW);

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(run().status).toBe(WorkflowRunStatus.PreActions);
  });

  it("only runs the pre action runs of the current cycle", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions, cycle: 2 });
    addPreActionRun({
      actionId: "pre-a",
      cycle: 1,
      status: WorkflowActionRunStatus.Failed,
      lastError: "old failure",
    });
    addPreActionRun({ actionId: "pre-a", cycle: 2 });

    await advanceRun(RUN_ID, NOW);

    expect(executed()).toHaveLength(1);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("skips the pre action runs that never ran when the run is cancelled", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    const waiting = addPreActionRun({
      actionId: "pre-a",
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });

    await cancelRun(ORG_ID, RUN_ID);

    expect(run().status).toBe(WorkflowRunStatus.Cancelled);
    expect(waiting.status).toBe(WorkflowActionRunStatus.Skipped);
  });

  it("runs no pre action for a workflow disabled before the run started", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({
      status: WorkflowRunStatus.Received,
      workflow: { name: "Jira to PR", enabled: false, projectId: null },
    });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.WorkflowDisabled,
    });
    expect(fake.actionDb.actionRuns).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("stops a run in pre_actions whose workflow was disabled meanwhile", async () => {
    addPreAction("pre-a", 0);
    fake.setRun({
      status: WorkflowRunStatus.PreActions,
      workflow: { name: "Jira to PR", enabled: false, projectId: null },
    });
    const pending = addPreActionRun({ actionId: "pre-a" });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.WorkflowDisabled,
    });
    expect(pending.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
