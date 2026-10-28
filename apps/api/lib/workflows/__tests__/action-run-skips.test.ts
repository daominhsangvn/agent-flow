import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionRunsDbFake,
  createActionRunsDbFake,
  type FakeRow,
} from "@/lib/workflows/__tests__/support/action-runs-db.test-fake";
import {
  RUN_CANCELLED_SKIP_REASON,
  skipPendingPostActionRuns,
  skipUnfinishedPreActionRuns,
} from "@/lib/workflows/engine/actions";

const mocks = vi.hoisted(() => ({ fake: null as ActionRunsDbFake | null }));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: (fn: (client: unknown) => unknown) => fn(mocks.fake?.db),
}));

const RUN_ID = "run-1";

let fake: ActionRunsDbFake;

beforeEach(() => {
  fake = createActionRunsDbFake();
  mocks.fake = fake;
});

describe("skipUnfinishedPreActionRuns", () => {
  it("skips the cycle's pending and running pre rows only", async () => {
    const pending = addRow({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
    });
    const done = addRow({
      actionId: "action-2",
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
      status: WorkflowActionRunStatus.Succeeded,
    });
    const post = addRow();
    const otherCycle = addRow({
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

describe("skipPendingPostActionRuns", () => {
  it("skips the run's post rows that have not started", async () => {
    const pending = addRow();
    const waiting = addRow({ status: WorkflowActionRunStatus.Waiting });
    const pre = addRow({ stage: WorkflowActionStage.Pre });
    const other = addRow({ runId: "run-2" });

    await skipPendingPostActionRuns(RUN_ID, RUN_CANCELLED_SKIP_REASON);

    expect(pending.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(waiting.status).toBe(WorkflowActionRunStatus.Waiting);
    expect(pre.status).toBe(WorkflowActionRunStatus.Pending);
    expect(other.status).toBe(WorkflowActionRunStatus.Pending);
  });
});

describe("skipPendingPostActionRuns", () => {
  it("skips the run's post rows that have not started", async () => {
    const pending = addRow();
    const waiting = addRow({ status: WorkflowActionRunStatus.Waiting });
    const pre = addRow({
      stage: WorkflowActionStage.Pre,
      event: WorkflowRunEvent.Triggered,
    });
    const other = addRow({ runId: "run-2" });

    const skipped = await skipPendingPostActionRuns(
      RUN_ID,
      RUN_CANCELLED_SKIP_REASON
    );

    expect(skipped).toBe(1);
    expect(pending).toMatchObject({
      status: WorkflowActionRunStatus.Skipped,
      lastError: RUN_CANCELLED_SKIP_REASON,
    });
    expect(waiting.status).toBe(WorkflowActionRunStatus.Waiting);
    expect(pre.status).toBe(WorkflowActionRunStatus.Pending);
    expect(other.status).toBe(WorkflowActionRunStatus.Pending);
  });
});

function addRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return fake.addActionRun({
    organizationId: "org-1",
    runId: RUN_ID,
    actionId: "action-1",
    actionType: "fake.add_comment",
    nextAttemptAt: new Date("2026-10-01T11:59:59.000Z"),
    ...overrides,
  });
}
