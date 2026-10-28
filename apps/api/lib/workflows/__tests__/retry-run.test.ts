import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  AgentFlowStepId,
  deriveProcessFromAgentConfig,
  RunProcessSource,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runLoopState as loop,
  NOW,
} from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  type AdvanceDbFake,
  AGENT_CONFIG,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  ORG_ID,
  PLAN_DOCUMENT_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { RetryRunFailure, retryRun } from "@/lib/workflows/engine/advance";
import { runError } from "@/lib/workflows/engine/errors";
import { findRetryableStep } from "@/lib/workflows/engine/retry-step";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/** Retry of a failed run's step (engine/retry-step.ts, advance.ts retryRun). */

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  launchWorkflowLoop: vi.fn(),
  approvePlanDocument: vi.fn(),
  findLatestRunLoop: vi.fn(),
  enqueueRunEvents: vi.fn(),
  drainActionRuns: vi.fn(),
  hasPostEvents: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/advance-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb, Prisma: { DbNull: support.PRISMA_DB_NULL } };
});
vi.mock("@/lib/workflows/engine/launch", () => ({
  launchWorkflowLoop: mocks.launchWorkflowLoop,
}));
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/documents", () => ({
  ensureRunDocuments: vi.fn(),
  approvePlanDocument: mocks.approvePlanDocument,
  markIssueInReview: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-loops")>();
  return { ...original, findLatestRunLoop: mocks.findLatestRunLoop };
});
vi.mock("@/lib/workflows/engine/actions", () => ({
  enqueueRunEvents: mocks.enqueueRunEvents,
  drainActionRuns: mocks.drainActionRuns,
  hasEnabledPreActions: vi.fn(),
  hasPostEvents: mocks.hasPostEvents,
  skipUnfinishedPreActionRuns: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/cancel", () => ({ cancelRunLoops: vi.fn() }));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const PROCESS = {
  version: 1,
  source: RunProcessSource.Project,
  definition: deriveProcessFromAgentConfig(AGENT_CONFIG),
};
const FAILED_AT = new Date(NOW.getTime() - 60_000);

let fake: AdvanceDbFake;
let linkedLoops: RunLoopState[];

beforeEach(() => {
  vi.clearAllMocks();
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  // The EXECUTE loop that failed, linked before the run failed.
  linkedLoops = [
    loop({
      loopId: "failed-execute",
      command: LoopCommand.Execute,
      status: LoopStatus.Failed,
      linkedAt: new Date(FAILED_AT.getTime() - 3_600_000),
    }),
  ];
  mocks.launchWorkflowLoop.mockImplementation(
    (input: { command: RunLoopState["command"] }) => {
      const loopId = `launched-${linkedLoops.length}`;
      linkedLoops.push(
        loop({ loopId, command: input.command, status: LoopStatus.Pending })
      );
      return Promise.resolve(Result.ok({ loopId, computeTargetId: "ct-1" }));
    }
  );
  mocks.findLatestRunLoop.mockImplementation(
    (_runId: string, command: string, since?: Date) =>
      Promise.resolve(
        linkedLoops
          .filter(
            (entry) =>
              entry.command === command && (!since || entry.linkedAt >= since)
          )
          .at(-1) ?? null
      )
  );
  mocks.approvePlanDocument.mockResolvedValue(undefined);
  mocks.enqueueRunEvents.mockResolvedValue(1);
  mocks.drainActionRuns.mockResolvedValue({});
  mocks.hasPostEvents.mockReturnValue(true);
});

function setFailedRun(
  stepId: string,
  code: WorkflowRunErrorCode = WorkflowRunErrorCode.ExecuteFailed
) {
  fake.setRun({
    status: WorkflowRunStatus.Failed,
    cycle: 3,
    process: PROCESS,
    stepId,
    featureDocumentId: FEATURE_DOCUMENT_ID,
    planDocumentId: PLAN_DOCUMENT_ID,
    error: runError(code, "The EXECUTE loop ended with status FAILED."),
    phaseStartedAt: FAILED_AT,
    completedAt: FAILED_AT,
  });
}

function run() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

describe("retryRun", () => {
  it("runs a failed implement step again in a new cycle", async () => {
    setFailedRun(AgentFlowStepId.Execute);

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(Result.ok(null));

    expect(mocks.launchWorkflowLoop).toHaveBeenCalledTimes(1);
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        command: LoopCommand.Execute,
        planDocumentId: PLAN_DOCUMENT_ID,
      })
    );
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Executing,
      cycle: 4,
      stepId: AgentFlowStepId.Execute,
      completedAt: null,
      leaseUntil: null,
    });
    expect(run().error).not.toMatchObject({ code: expect.any(String) });
    expect(mocks.enqueueRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, cycle: 4 }),
      [WorkflowRunEvent.ExecuteStarted],
      expect.any(Date)
    );
  });

  it("runs a failed plan step again", async () => {
    setFailedRun(AgentFlowStepId.Plan, WorkflowRunErrorCode.PlanFailed);

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(Result.ok(null));

    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith(
      expect.objectContaining({ command: LoopCommand.Plan })
    );
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Planning,
      cycle: 4,
    });
  });

  it("leaves a rejected run alone", async () => {
    setFailedRun(
      AgentFlowStepId.Execute,
      WorkflowRunErrorCode.ApprovalRejected
    );

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(
      Result.err({ failure: RetryRunFailure.NotRetryable })
    );
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Failed,
      cycle: 3,
      leaseUntil: null,
    });
  });

  it("runs the step a cancelled run stopped in again", async () => {
    setFailedRun(AgentFlowStepId.Execute, WorkflowRunErrorCode.Cancelled);
    run().status = WorkflowRunStatus.Cancelled;

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(Result.ok(null));

    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith(
      expect.objectContaining({ command: LoopCommand.Execute })
    );
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Executing,
      cycle: 4,
    });
  });

  it("does not retry a run that has not failed", async () => {
    setFailedRun(AgentFlowStepId.Execute);
    run().status = WorkflowRunStatus.Executing;

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(
      Result.err({ failure: RetryRunFailure.NotRetryable })
    );
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
  });

  it("reports a step that cannot start and keeps the run failed", async () => {
    setFailedRun(AgentFlowStepId.Execute);
    const offline = runError(
      WorkflowRunErrorCode.ComputeTargetUnavailable,
      "The run's computer is offline."
    );
    mocks.launchWorkflowLoop.mockResolvedValue(Result.err(offline));

    await expect(retryRun(ORG_ID, RUN_ID)).resolves.toEqual(
      Result.err({ failure: RetryRunFailure.StartFailed, error: offline })
    );
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Failed,
      cycle: 3,
      leaseUntil: null,
    });
    expect(mocks.enqueueRunEvents).not.toHaveBeenCalled();
  });
});

describe("findRetryableStep", () => {
  it("finds the failed loop step of a process run", () => {
    expect(
      findRetryableStep({
        status: WorkflowRunStatus.Failed,
        error: runError(WorkflowRunErrorCode.ExecuteFailed, "failed"),
        process: PROCESS,
        stepId: AgentFlowStepId.Execute,
      })
    ).toMatchObject({ id: AgentFlowStepId.Execute });
  });

  it("finds nothing on the built-in flow or before a step started", () => {
    const failed = {
      status: WorkflowRunStatus.Failed,
      error: runError(WorkflowRunErrorCode.SourceFetchFailed, "failed"),
    };
    expect(findRetryableStep(failed)).toBeNull();
    expect(
      findRetryableStep({ ...failed, process: PROCESS, stepId: null })
    ).toBeNull();
  });
});
