import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableSourceError } from "@/lib/integrations/types";
import { ReapReason } from "@/lib/observability/loop-runner-metrics";
import {
  connectionWithItem,
  DAY_MS,
  HOUR_MS,
  runLoopState as loop,
  NOW,
  reaperTimeoutEvent,
  SOURCE_TOKEN,
} from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  type AdvanceDbFake,
  AGENT_CONFIG,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  ORG_ID,
  PLAN_DOCUMENT_ID,
  PRISMA_DB_NULL,
  RUN_AS_USER_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import {
  AdvanceRunOutcome,
  advanceRun,
  CancelRunFailure,
  cancelRun,
} from "@/lib/workflows/engine/advance";
import { runError } from "@/lib/workflows/engine/errors";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  launchWorkflowLoop: vi.fn(),
  ensureRunDocuments: vi.fn(),
  approvePlanDocument: vi.fn(),
  markIssueInReview: vi.fn(),
  findLatestRunLoop: vi.fn(),
  findAdoptableLoop: vi.fn(),
  recordRunLoop: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  findLoopById: vi.fn(),
  enqueueRunEvents: vi.fn(),
  drainActionRuns: vi.fn(),
  hasEnabledPreActions: vi.fn(),
  hasPostEvents: vi.fn(),
  skipUnfinishedPreActionRuns: vi.fn(),
  runPreActions: vi.fn(),
  cancelRunLoops: vi.fn(),
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
// Agent steps launch STEP loops; the built-in flow never does.
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/documents", () => ({
  ensureRunDocuments: mocks.ensureRunDocuments,
  approvePlanDocument: mocks.approvePlanDocument,
  markIssueInReview: mocks.markIssueInReview,
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-loops")>();
  return {
    ...original,
    findLatestRunLoop: mocks.findLatestRunLoop,
    findAdoptableLoop: mocks.findAdoptableLoop,
    recordRunLoop: mocks.recordRunLoop,
  };
});
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/app/loops/service", () => ({
  loopsService: { findById: mocks.findLoopById },
}));
vi.mock("@/lib/workflows/engine/actions", () => ({
  enqueueRunEvents: mocks.enqueueRunEvents,
  drainActionRuns: mocks.drainActionRuns,
  hasEnabledPreActions: mocks.hasEnabledPreActions,
  hasPostEvents: mocks.hasPostEvents,
  skipUnfinishedPreActionRuns: mocks.skipUnfinishedPreActionRuns,
}));
// The pre_actions step itself is covered end to end in pre-actions.test.ts.
vi.mock("@/lib/workflows/engine/pre-actions", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/pre-actions")>();
  return { ...original, runPreActions: mocks.runPreActions };
});
vi.mock("@/lib/workflows/engine/cancel", () => ({
  cancelRunLoops: mocks.cancelRunLoops,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

let fake: AdvanceDbFake;
/** Loops linked to the run, as workflow_run_loops rows would hold them. */
let linkedLoops: RunLoopState[];

beforeEach(() => {
  vi.clearAllMocks();
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  mocks.ensureRunDocuments.mockResolvedValue(
    Result.ok({
      featureDocumentId: FEATURE_DOCUMENT_ID,
      planDocumentId: PLAN_DOCUMENT_ID,
    })
  );
  linkedLoops = [];
  mocks.launchWorkflowLoop.mockImplementation(
    (input: { command: RunLoopState["command"] }) => {
      const loopId = `launched-${linkedLoops.length + 1}`;
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
  mocks.findAdoptableLoop.mockResolvedValue(null);
  mocks.approvePlanDocument.mockResolvedValue(undefined);
  mocks.markIssueInReview.mockResolvedValue(undefined);
  mocks.enqueueRunEvents.mockResolvedValue(1);
  mocks.drainActionRuns.mockResolvedValue({});
  mocks.hasEnabledPreActions.mockResolvedValue(false);
  mocks.hasPostEvents.mockImplementation((events: WorkflowRunEvent[]) =>
    events.some((event) => event !== WorkflowRunEvent.Triggered)
  );
  mocks.skipUnfinishedPreActionRuns.mockResolvedValue(0);
  mocks.runPreActions.mockResolvedValue({ kind: PreActionsOutcomeKind.Done });
  mocks.loadConnectionRuntime.mockResolvedValue(connectionWithItem());
});

function run() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

function enqueuedEvents(): WorkflowRunEvent[] {
  return mocks.enqueueRunEvents.mock.calls.flatMap(
    (call) => call[1] as WorkflowRunEvent[]
  );
}

function reapEvent(loopId: string, reason: string) {
  fake.state.loopEvents.push(reaperTimeoutEvent(loopId, reason));
}

describe("advanceRun — setup", () => {
  it("imports the item, launches PLAN and enters planning in one call", async () => {
    fake.setRun({ status: WorkflowRunStatus.Received });

    const outcome = await advanceRun(RUN_ID, NOW);

    expect(outcome).toBe(AdvanceRunOutcome.Advanced);
    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(run().phaseStartedAt).toEqual(NOW);
    expect(run().leaseUntil).toBeNull();
    expect(mocks.ensureRunDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: expect.any(String),
        runAsUserId: RUN_AS_USER_ID,
        workflowName: "Jira to PR",
        item: expect.objectContaining({ key: "PROJ-7", bodyMarkdown: "body" }),
      })
    );
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith({
      runId: RUN_ID,
      organizationId: ORG_ID,
      runAsUser: { id: RUN_AS_USER_ID, clerkId: "auth-user-1" },
      planDocumentId: PLAN_DOCUMENT_ID,
      command: LoopCommand.Plan,
      agent: AGENT_CONFIG,
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Started]);
    expect(mocks.waitUntil).toHaveBeenCalled();
    expect(mocks.hasEnabledPreActions).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: expect.any(String) })
    );
    expect(mocks.runPreActions).not.toHaveBeenCalled();
  });

  it("uses the inline item without fetching", async () => {
    const fetchItem = vi.fn();
    mocks.loadConnectionRuntime.mockResolvedValue(
      connectionWithItem(fetchItem)
    );
    const stored = {
      item: {
        provider: IntegrationProviderKey.Webhook,
        externalId: "evt-1",
        key: "REQ-7",
        url: null,
        title: "Inline",
        container: null,
      },
      inlineItem: {
        provider: IntegrationProviderKey.Webhook,
        externalId: "evt-1",
        key: "REQ-7",
        url: null,
        title: "Inline",
        container: null,
        bodyMarkdown: "inline body",
      },
      actor: null,
      attributes: {},
      extras: {},
      occurredAt: NOW.toISOString(),
    };
    fake.setRun({ status: WorkflowRunStatus.Ingesting, source: stored });

    await advanceRun(RUN_ID, NOW);

    expect(fetchItem).not.toHaveBeenCalled();
    expect(mocks.ensureRunDocuments.mock.calls[0][0].item).toMatchObject({
      key: "REQ-7",
      bodyMarkdown: "inline body",
    });
  });

  it("does not send run.started again when a resumed run plans again", async () => {
    fake.setRun({ status: WorkflowRunStatus.Ingesting, cycle: 2 });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(enqueuedEvents()).toEqual([]);
  });

  it("does not launch a second PLAN when one was launched in this phase", async () => {
    fake.setRun({ status: WorkflowRunStatus.Ingesting });
    linkedLoops.push(loop({ linkedAt: new Date("2026-10-01T00:30:00.000Z") }));

    await advanceRun(RUN_ID, NOW);

    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("fails a run whose workflow was disabled", async () => {
    fake.setRun({
      status: WorkflowRunStatus.Received,
      workflow: { name: "w", enabled: false, projectId: "p" },
    });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.WorkflowDisabled,
    });
    expect(run().completedAt).toEqual(NOW);
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Failed]);
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
  });

  it("fails when the run-as user is no longer an active member", async () => {
    fake.state.runAsUserActive = false;
    fake.setRun({ status: WorkflowRunStatus.Ingesting });

    await advanceRun(RUN_ID, NOW);

    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.RunAsUserMissing,
    });
  });

  it("fails with source_fetch_failed and keeps secrets out of the message", async () => {
    const fetchItem = vi.fn();
    const connection = connectionWithItem(fetchItem);
    fetchItem.mockRejectedValue(new Error(`401 for token ${SOURCE_TOKEN}`));
    mocks.loadConnectionRuntime.mockResolvedValue(connection);
    fake.setRun({ status: WorkflowRunStatus.Ingesting });

    await advanceRun(RUN_ID, NOW);

    const error = run().error as { code: string; message: string };
    expect(error.code).toBe(WorkflowRunErrorCode.SourceFetchFailed);
    expect(error.message).toContain("PROJ-7");
    expect(error.message).not.toContain(SOURCE_TOKEN);
  });

  it("retries a temporary source failure with backoff instead of failing the run", async () => {
    const fetchItem = vi.fn();
    const connection = connectionWithItem(fetchItem);
    const item = await fetchItem();
    fetchItem.mockReset();
    fetchItem
      .mockRejectedValueOnce(new RetryableSourceError("HTTP 429 from Jira"))
      .mockResolvedValueOnce(item);
    mocks.loadConnectionRuntime.mockResolvedValue(connection);
    fake.setRun({ status: WorkflowRunStatus.Ingesting });

    await advanceRun(RUN_ID, NOW);

    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Ingesting,
      stepAttempts: 1,
      nextStepAt: new Date(NOW.getTime() + 30_000),
      error: null,
      leaseUntil: null,
    });
    expect(enqueuedEvents()).toEqual([]);
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();

    // Before the backoff elapsed the run is not stepped at all.
    await expect(
      advanceRun(RUN_ID, new Date(NOW.getTime() + 10_000))
    ).resolves.toBe(AdvanceRunOutcome.Skipped);
    expect(fetchItem).toHaveBeenCalledTimes(1);

    const later = new Date(NOW.getTime() + 31_000);
    await advanceRun(RUN_ID, later);

    expect(fetchItem).toHaveBeenCalledTimes(2);
    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Planning,
      stepAttempts: 0,
      nextStepAt: null,
      phaseStartedAt: later,
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Started]);
  });

  it("backs off longer on later attempts and fails after the fifth", async () => {
    const fetchItem = vi.fn();
    const connection = connectionWithItem(fetchItem);
    fetchItem.mockRejectedValue(new RetryableSourceError("HTTP 503"));
    mocks.loadConnectionRuntime.mockResolvedValue(connection);
    fake.setRun({ status: WorkflowRunStatus.Ingesting, stepAttempts: 3 });

    await advanceRun(RUN_ID, NOW);

    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Ingesting,
      stepAttempts: 4,
      nextStepAt: new Date(NOW.getTime() + 30 * 60_000),
    });

    await advanceRun(RUN_ID, new Date(NOW.getTime() + 31 * 60_000));

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toEqual({
      code: WorkflowRunErrorCode.SourceFetchFailed,
      message:
        "Could not load PROJ-7 from Jira: HTTP 503 (gave up after 5 attempts)",
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Failed]);
    expect(fetchItem).toHaveBeenCalledTimes(2);
  });

  it("fails with the launch error", async () => {
    mocks.launchWorkflowLoop.mockResolvedValue(
      Result.err(runError(WorkflowRunErrorCode.SigningRequired, "signing"))
    );
    fake.setRun({ status: WorkflowRunStatus.Ingesting });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toEqual({
      code: WorkflowRunErrorCode.SigningRequired,
      message: "signing",
    });
  });

  it("fails setup that throws unexpectedly with internal_error", async () => {
    mocks.ensureRunDocuments.mockRejectedValue(new Error("boom"));
    fake.setRun({ status: WorkflowRunStatus.Ingesting });

    await advanceRun(RUN_ID, NOW);

    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.InternalError,
    });
    expect(run().leaseUntil).toBeNull();
  });
});

describe("advanceRun — pre actions", () => {
  beforeEach(() => {
    mocks.hasEnabledPreActions.mockResolvedValue(true);
  });

  it("enqueues run.triggered and enters pre_actions when the workflow has pre actions", async () => {
    mocks.runPreActions.mockResolvedValue({ kind: PreActionsOutcomeKind.Wait });
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.PreActions);
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Triggered]);
    expect(mocks.enqueueRunEvents.mock.calls[0][0]).toMatchObject({
      id: RUN_ID,
      cycle: 1,
    });
    expect(mocks.runPreActions).toHaveBeenCalledWith(
      expect.objectContaining({ run: { id: RUN_ID, cycle: 1 }, now: NOW })
    );
    expect(mocks.drainActionRuns).not.toHaveBeenCalled();
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
    expect(run().leaseUntil).toBeNull();
  });

  it("continues with the agent team in the same call once the pre actions are done", async () => {
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(enqueuedEvents()).toEqual([
      WorkflowRunEvent.Triggered,
      WorkflowRunEvent.Started,
    ]);
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledTimes(1);
  });

  it("fails the run with the pre action error and skips the remaining pre rows", async () => {
    const error = runError(
      WorkflowRunErrorCode.PreActionFailed,
      "Pre action Transition issue failed: HTTP 400"
    );
    mocks.runPreActions.mockResolvedValue({
      kind: PreActionsOutcomeKind.Failed,
      error,
    });
    fake.setRun({ status: WorkflowRunStatus.PreActions, cycle: 2 });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toEqual(error);
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Failed]);
    expect(mocks.skipUnfinishedPreActionRuns).toHaveBeenCalledWith(
      { id: RUN_ID, cycle: 2 },
      expect.any(String)
    );
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
  });

  it("keeps the run in pre_actions when a step throws, for the next tick", async () => {
    mocks.runPreActions.mockRejectedValue(new Error("db hiccup"));
    fake.setRun({ status: WorkflowRunStatus.PreActions });

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.PreActions);
    expect(run().leaseUntil).toBeNull();
  });

  it("renews the lease it holds when asked", async () => {
    const renewals: boolean[] = [];
    mocks.runPreActions.mockImplementation(
      async (context: { renewLease(): Promise<boolean> }) => {
        renewals.push(await context.renewLease());
        return { kind: PreActionsOutcomeKind.Wait };
      }
    );
    fake.setRun({ status: WorkflowRunStatus.PreActions });
    // Earlier work in this call took 5 minutes of wall-clock time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));

    try {
      await advanceRun(RUN_ID, NOW);
    } finally {
      vi.useRealTimers();
    }

    const leaseWrites = fake.db.workflowRun.updateMany.mock.calls.map(
      (call) => call[0].data.leaseUntil
    );
    expect(renewals).toEqual([true]);
    // acquire (now + 2 min), renew (wall clock + 2 min), release
    expect(leaseWrites).toEqual([
      new Date(NOW.getTime() + 2 * 60_000),
      new Date(NOW.getTime() + 7 * 60_000),
      null,
    ]);
    expect(run().leaseUntil).toBeNull();
  });
});

describe("advanceRun — lease", () => {
  it("skips a run another worker holds", async () => {
    fake.setRun({
      status: WorkflowRunStatus.Received,
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });

    await expect(advanceRun(RUN_ID, NOW)).resolves.toBe(
      AdvanceRunOutcome.Skipped
    );
    expect(run().status).toBe(WorkflowRunStatus.Received);
  });

  it("takes over an expired lease", async () => {
    fake.setRun({
      status: WorkflowRunStatus.Received,
      leaseUntil: new Date(NOW.getTime() - 1),
    });

    await expect(advanceRun(RUN_ID, NOW)).resolves.toBe(
      AdvanceRunOutcome.Advanced
    );
    expect(run().status).toBe(WorkflowRunStatus.Planning);
  });

  it("never touches a final run", async () => {
    fake.setRun({ status: WorkflowRunStatus.Succeeded });

    await expect(advanceRun(RUN_ID, NOW)).resolves.toBe(
      AdvanceRunOutcome.Skipped
    );
    expect(mocks.findLatestRunLoop).not.toHaveBeenCalled();
  });

  it("keeps a waiting-phase run and releases the lease when a check throws", async () => {
    fake.setRun({ status: WorkflowRunStatus.Planning });
    mocks.findLatestRunLoop.mockRejectedValue(new Error("db hiccup"));

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(run().leaseUntil).toBeNull();
  });
});

describe("advanceRun — planning", () => {
  beforeEach(() => {
    fake.setRun({
      status: WorkflowRunStatus.Planning,
      planDocumentId: PLAN_DOCUMENT_ID,
      featureDocumentId: FEATURE_DOCUMENT_ID,
      phaseStartedAt: new Date(NOW.getTime() - 60_000),
    });
  });

  it("waits while the PLAN loop runs", async () => {
    linkedLoops.push(loop());

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(mocks.enqueueRunEvents).not.toHaveBeenCalled();
  });

  it("fails a phase that exceeded the timeout", async () => {
    run().phaseStartedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    linkedLoops.push(loop());

    await advanceRun(RUN_ID, NOW);

    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.PhaseTimeout,
    });
  });

  it("succeeds a plan-only run with plan_ready and succeeded", async () => {
    run().agentConfig = { ...AGENT_CONFIG, mode: WorkflowAgentMode.Plan };
    linkedLoops.push(loop({ status: LoopStatus.Completed }));

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Succeeded);
    expect(run().completedAt).toEqual(NOW);
    expect(run().error).toBe(PRISMA_DB_NULL);
    expect(enqueuedEvents()).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.Succeeded,
    ]);
  });

  it("stops in needs_input when the plan has open questions", async () => {
    linkedLoops.push(
      loop({
        status: LoopStatus.Completed,
        uploadedArtifacts: {
          plan: { raw: { openQuestions: [{ question: "Which format?" }] } },
        },
      })
    );

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(enqueuedEvents()).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.NeedsInput,
    ]);
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
  });

  it("approves the plan and launches EXECUTE when there are no questions", async () => {
    linkedLoops.push(loop({ status: LoopStatus.Completed }));

    await advanceRun(RUN_ID, NOW);

    expect(mocks.approvePlanDocument).toHaveBeenCalledWith(
      PLAN_DOCUMENT_ID,
      ORG_ID
    );
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith(
      expect.objectContaining({ command: LoopCommand.Execute })
    );
    expect(run().status).toBe(WorkflowRunStatus.Executing);
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.PlanReady]);
  });

  it("fails with plan_state_unavailable when the plan cannot be approved", async () => {
    linkedLoops.push(loop({ status: LoopStatus.Completed }));
    mocks.approvePlanDocument.mockRejectedValue(
      new Error("Document not found")
    );

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.PlanStateUnavailable,
    });
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
    expect(enqueuedEvents()).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.Failed,
    ]);
  });

  it("launches EXECUTE despite open questions when not asked to stop", async () => {
    run().agentConfig = { ...AGENT_CONFIG, stopOnOpenQuestions: false };
    linkedLoops.push(
      loop({
        status: LoopStatus.Completed,
        uploadedArtifacts: {
          plan: { raw: { openQuestions: [{ question: "Q?" }] } },
        },
      })
    );

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Executing);
  });

  it("fails with the loop error when PLAN fails", async () => {
    linkedLoops.push(
      loop({
        status: LoopStatus.Failed,
        error: { code: "LAUNCH_FAILED", message: "desktop offline" },
      })
    );

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toEqual({
      code: WorkflowRunErrorCode.PlanFailed,
      message: "The PLAN loop ended with status FAILED: desktop offline",
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Failed]);
  });

  it.each([
    ReapReason.DesktopHeartbeatStale,
    ReapReason.DesktopNoHeartbeat,
  ])("waits for a PLAN loop timed out for %s that its desktop can still revive", async (reason) => {
    linkedLoops.push(
      loop({
        status: LoopStatus.TimedOut,
        completedAt: new Date(NOW.getTime() - HOUR_MS),
        revivalCount: 2,
      })
    );
    reapEvent("loop-1", reason);

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(run().error).toBeNull();
    expect(enqueuedEvents()).toEqual([]);
  });

  it.each([
    [
      "reaped for another reason",
      { completedAt: new Date(NOW.getTime() - HOUR_MS) },
      ReapReason.DesktopLegacy24h,
    ],
    [
      "revived the maximum number of times",
      { completedAt: new Date(NOW.getTime() - HOUR_MS), revivalCount: 3 },
      ReapReason.DesktopHeartbeatStale,
    ],
    [
      "past the revival grace window",
      { completedAt: new Date(NOW.getTime() - 8 * DAY_MS) },
      ReapReason.DesktopHeartbeatStale,
    ],
  ])("fails on a timed-out PLAN loop %s", async (_label, overrides, reason) => {
    linkedLoops.push(loop({ status: LoopStatus.TimedOut, ...overrides }));
    reapEvent("loop-1", reason);

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Failed);
    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.PlanFailed,
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Failed]);
  });

  it("bounds the wait for a revivable loop by the phase timeout", async () => {
    run().phaseStartedAt = new Date(NOW.getTime() - 25 * HOUR_MS);
    linkedLoops.push(
      loop({
        status: LoopStatus.TimedOut,
        completedAt: new Date(NOW.getTime() - HOUR_MS),
      })
    );
    reapEvent("loop-1", ReapReason.DesktopHeartbeatStale);

    await advanceRun(RUN_ID, NOW);

    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.PhaseTimeout,
    });
  });
});

describe("advanceRun — executing", () => {
  beforeEach(() => {
    fake.setRun({
      status: WorkflowRunStatus.Executing,
      planDocumentId: PLAN_DOCUMENT_ID,
      featureDocumentId: FEATURE_DOCUMENT_ID,
      phaseStartedAt: new Date(NOW.getTime() - 60_000),
    });
  });

  it("records the PR, moves the issue to review and succeeds", async () => {
    linkedLoops.push(
      loop({
        command: LoopCommand.Execute,
        status: LoopStatus.Completed,
        prUrl: "https://github.com/acme/app/pull/12",
        branchName: "feat/csv",
      })
    );

    await advanceRun(RUN_ID, NOW);

    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Succeeded,
      prUrl: "https://github.com/acme/app/pull/12",
      branchName: "feat/csv",
    });
    expect(mocks.markIssueInReview).toHaveBeenCalledWith(
      FEATURE_DOCUMENT_ID,
      ORG_ID
    );
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Succeeded]);
  });

  it("falls back to the loop's linked pull request", async () => {
    linkedLoops.push(
      loop({ command: LoopCommand.Execute, status: LoopStatus.Completed })
    );
    mocks.findLoopById.mockResolvedValue({
      primaryPullRequest: {
        htmlUrl: "https://github.com/acme/app/pull/13",
        headBranch: "feat/pr",
      },
      primaryBranch: null,
    });

    await advanceRun(RUN_ID, NOW);

    expect(run()).toMatchObject({
      prUrl: "https://github.com/acme/app/pull/13",
      branchName: "feat/pr",
    });
  });

  it("fails when EXECUTE times out", async () => {
    linkedLoops.push(
      loop({ command: LoopCommand.Execute, status: LoopStatus.TimedOut })
    );

    await advanceRun(RUN_ID, NOW);

    expect(run().error).toMatchObject({
      code: WorkflowRunErrorCode.ExecuteFailed,
    });
  });

  it("waits for an EXECUTE loop that a sleeping desktop can still revive, then succeeds", async () => {
    const executeLoop = loop({
      loopId: "loop-exec",
      command: LoopCommand.Execute,
      status: LoopStatus.TimedOut,
      completedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    });
    linkedLoops.push(executeLoop);
    reapEvent("loop-exec", ReapReason.DesktopHeartbeatStale);

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Executing);
    expect(enqueuedEvents()).toEqual([]);

    // The laptop wakes: the loop is revived and completes.
    Object.assign(executeLoop, {
      status: LoopStatus.Completed,
      prUrl: "https://github.com/acme/app/pull/14",
      revivalCount: 1,
    });
    await advanceRun(RUN_ID, NOW);

    expect(run()).toMatchObject({
      status: WorkflowRunStatus.Succeeded,
      prUrl: "https://github.com/acme/app/pull/14",
    });
    expect(enqueuedEvents()).toEqual([WorkflowRunEvent.Succeeded]);
  });
});

describe("advanceRun — needs_input", () => {
  beforeEach(() => {
    fake.setRun({
      status: WorkflowRunStatus.NeedsInput,
      planDocumentId: PLAN_DOCUMENT_ID,
    });
  });

  it("waits when nobody started a loop on the plan", async () => {
    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(mocks.findAdoptableLoop).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      planDocumentId: PLAN_DOCUMENT_ID,
      since: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  it("adopts an EXECUTE loop started on the plan", async () => {
    mocks.findAdoptableLoop.mockResolvedValue({
      id: "loop-9",
      command: LoopCommand.Execute,
    });
    linkedLoops.push(loop({ loopId: "loop-9", command: LoopCommand.Execute }));

    await advanceRun(RUN_ID, NOW);

    expect(mocks.recordRunLoop).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      runId: RUN_ID,
      loopId: "loop-9",
      command: LoopCommand.Execute,
      adopted: true,
    });
    expect(run().status).toBe(WorkflowRunStatus.Executing);
  });

  it("adopts a PLAN loop and goes back to planning in the next cycle", async () => {
    mocks.findAdoptableLoop.mockResolvedValue({
      id: "loop-8",
      command: LoopCommand.Plan,
    });
    linkedLoops.push(loop({ loopId: "loop-8" }));

    await advanceRun(RUN_ID, NOW);

    expect(run().status).toBe(WorkflowRunStatus.Planning);
    expect(run().cycle).toBe(2);
    expect(mocks.hasEnabledPreActions).not.toHaveBeenCalled();
    expect(enqueuedEvents()).toEqual([]);
  });

  it("keeps the cycle when it adopts an EXECUTE loop", async () => {
    mocks.findAdoptableLoop.mockResolvedValue({
      id: "loop-9",
      command: LoopCommand.Execute,
    });
    linkedLoops.push(loop({ loopId: "loop-9", command: LoopCommand.Execute }));

    await advanceRun(RUN_ID, NOW);

    expect(run().cycle).toBe(1);
  });
});

describe("cancelRun", () => {
  it("cancels the run's loops and writes cancelled", async () => {
    fake.setRun({ status: WorkflowRunStatus.Planning });

    const result = await cancelRun(ORG_ID, RUN_ID);

    expect(result).toEqual(Result.ok(null));
    expect(mocks.cancelRunLoops).toHaveBeenCalledWith(RUN_ID, ORG_ID);
    expect(run().status).toBe(WorkflowRunStatus.Cancelled);
    expect(run().error).toMatchObject({ code: WorkflowRunErrorCode.Cancelled });
    expect(run().completedAt).toBeInstanceOf(Date);
    expect(run().leaseUntil).toBeNull();
    expect(enqueuedEvents()).toEqual([]);
    expect(mocks.skipUnfinishedPreActionRuns).not.toHaveBeenCalled();
  });

  it("skips the pre action runs that did not run when cancelled in pre_actions", async () => {
    fake.setRun({ status: WorkflowRunStatus.PreActions });

    await cancelRun(ORG_ID, RUN_ID);

    expect(run().status).toBe(WorkflowRunStatus.Cancelled);
    expect(mocks.skipUnfinishedPreActionRuns).toHaveBeenCalledWith(
      { id: RUN_ID, cycle: 1 },
      expect.any(String)
    );
  });

  it("refuses a finished run", async () => {
    fake.setRun({ status: WorkflowRunStatus.Failed });

    await expect(cancelRun(ORG_ID, RUN_ID)).resolves.toEqual(
      Result.err(CancelRunFailure.AlreadyFinished)
    );
    expect(mocks.cancelRunLoops).not.toHaveBeenCalled();
  });

  it("reports a missing run", async () => {
    await expect(cancelRun(ORG_ID, RUN_ID)).resolves.toEqual(
      Result.err(CancelRunFailure.NotFound)
    );
  });
});
