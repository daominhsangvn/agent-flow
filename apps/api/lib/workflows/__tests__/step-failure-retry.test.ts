import {
  LOOP_STEP_ARTIFACT_KEY,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import {
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
} from "@repo/api/src/types/loop";
import {
  type ProcessStep,
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  type WorkflowRunEvent,
  WorkflowRunRetryMode,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionWithItem,
  runLoopState as loop,
  NOW,
} from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  type AdvanceDbFake,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  ORG_ID,
  PLAN_DOCUMENT_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import {
  advanceRun,
  RetryRunFailure,
  retryRun,
} from "@/lib/workflows/engine/advance";
import type { LaunchStepLoopInput } from "@/lib/workflows/engine/launch-step";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/**
 * A failed agent step run again (engine/agent-step.ts autoRetryOrFail,
 * agent-step-resume.ts resumeFailedStep, advance.ts retryRun): automatically
 * after a model provider failure and its backoff, or by an administrator,
 * resuming the failed session in a fork or restarting the step.
 */

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  ensureRunDocuments: vi.fn(),
  approvePlanDocument: vi.fn(),
  markIssueInReview: vi.fn(),
  launchWorkflowLoop: vi.fn(),
  launchStepLoop: vi.fn(),
  findLatestRunLoop: vi.fn(),
  findAdoptableLoop: vi.fn(),
  listRunLoops: vi.fn(),
  recordRunLoop: vi.fn(),
  recordRunRepositoryBranches: vi.fn(),
  getLatestDocumentVersion: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  findLoopById: vi.fn(),
  enqueueRunEvents: vi.fn(),
  drainActionRuns: vi.fn(),
  hasEnabledPreActions: vi.fn(),
  hasPostEvents: vi.fn(),
  skipUnfinishedPreActionRuns: vi.fn(),
  runPreActions: vi.fn(),
  cancelRunLoops: vi.fn(),
  publishStepDocument: vi.fn(),
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
  launchStepLoop: mocks.launchStepLoop,
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
    listRunLoops: mocks.listRunLoops,
    recordRunLoop: mocks.recordRunLoop,
  };
});
vi.mock("@/lib/workflows/engine/run-repository", () => ({
  recordRunRepositoryBranches: mocks.recordRunRepositoryBranches,
}));
vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: mocks.getLatestDocumentVersion },
}));
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
vi.mock("@/lib/workflows/engine/pre-actions", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/pre-actions")>();
  return { ...original, runPreActions: mocks.runPreActions };
});
vi.mock("@/lib/workflows/engine/cancel", () => ({
  cancelRunLoops: mocks.cancelRunLoops,
}));
vi.mock("@/lib/workflows/engine/step-documents", () => ({
  publishStepDocument: mocks.publishStepDocument,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

let fake: AdvanceDbFake;
let linkedLoops: RunLoopState[];
/** Step of each STEP loop (workflow_run_loops.step_id). */
let loopSteps: Map<string, string>;

function resetHarness() {
  vi.clearAllMocks();
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  linkedLoops = [];
  loopSteps = new Map();
  // Like the real ensureRunDocuments: the plan document only for a plan step.
  mocks.ensureRunDocuments.mockImplementation(
    (input: { withPlanDocument: boolean }) => {
      const documents = {
        featureDocumentId: FEATURE_DOCUMENT_ID,
        planDocumentId: input.withPlanDocument ? PLAN_DOCUMENT_ID : null,
      };
      Object.assign(currentRun(), documents);
      return Promise.resolve(Result.ok(documents));
    }
  );
  mocks.launchWorkflowLoop.mockImplementation(
    (input: { command: RunLoopState["command"] }) => {
      const loopId = `launched-${linkedLoops.length + 1}`;
      linkedLoops.push(
        loop({ loopId, command: input.command, status: LoopStatus.Pending })
      );
      return Promise.resolve(Result.ok({ loopId, computeTargetId: "ct-1" }));
    }
  );
  mocks.launchStepLoop.mockImplementation((input: LaunchStepLoopInput) => {
    const loopId = `step-${linkedLoops.length + 1}`;
    const computeTargetId = input.computeTargetId ?? "runner-1";
    linkedLoops.push(
      loop({
        loopId,
        command: LoopCommand.Step,
        status: LoopStatus.Pending,
        computeTargetId,
      })
    );
    loopSteps.set(loopId, input.step.stepId);
    return Promise.resolve(Result.ok({ loopId, computeTargetId }));
  });
  mocks.findLatestRunLoop.mockImplementation(
    (_runId: string, command: string, since?: Date, stepId?: string) =>
      Promise.resolve(
        linkedLoops
          .filter(
            (entry) =>
              entry.command === command &&
              (!since || entry.linkedAt >= since) &&
              (!stepId || loopSteps.get(entry.loopId) === stepId)
          )
          .at(-1) ?? null
      )
  );
  mocks.listRunLoops.mockImplementation(() =>
    Promise.resolve([...linkedLoops])
  );
  mocks.findAdoptableLoop.mockResolvedValue(null);
  mocks.getLatestDocumentVersion.mockResolvedValue({
    content: "Export the orders as CSV.",
  });
  mocks.recordRunRepositoryBranches.mockResolvedValue(undefined);
  mocks.approvePlanDocument.mockResolvedValue(undefined);
  mocks.markIssueInReview.mockResolvedValue(undefined);
  mocks.enqueueRunEvents.mockResolvedValue(1);
  mocks.drainActionRuns.mockResolvedValue({});
  mocks.hasEnabledPreActions.mockResolvedValue(false);
  mocks.hasPostEvents.mockReturnValue(true);
  mocks.skipUnfinishedPreActionRuns.mockResolvedValue(0);
  mocks.runPreActions.mockResolvedValue({ kind: PreActionsOutcomeKind.Done });
  mocks.loadConnectionRuntime.mockResolvedValue(connectionWithItem());
  mocks.publishStepDocument.mockResolvedValue(Result.ok(null));
}

function currentRun() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

function setProcess(process: ProjectProcessInput) {
  fake.state.projectProcess = {
    version: 2,
    definition: projectProcessSchema.parse(process),
  };
  fake.setRun({ status: WorkflowRunStatus.Received });
}

/** Ends the last loop of `command` (of `stepId` for STEP loops). */
function finish(
  command: LoopCommand,
  overrides: Partial<RunLoopState> = {},
  stepId?: string
): void {
  let index = -1;
  linkedLoops.forEach((entry, position) => {
    if (
      entry.command === command &&
      (!stepId || loopSteps.get(entry.loopId) === stepId)
    ) {
      index = position;
    }
  });
  const entry = linkedLoops[index];
  if (!entry) {
    throw new Error(`no ${command} loop launched`);
  }
  linkedLoops[index] = { ...entry, status: LoopStatus.Completed, ...overrides };
}

function stepUpload(
  stepId: string,
  result: Partial<LoopStepResult> = {},
  extra: Record<string, unknown> = {}
) {
  return {
    uploadedArtifacts: {
      [LOOP_STEP_ARTIFACT_KEY]: {
        stepId,
        questions: [],
        files: [],
        questionsError: null,
        ...result,
      },
      ...extra,
    },
  };
}

async function advance() {
  mocks.enqueueRunEvents.mockClear();
  await advanceRun(RUN_ID, NOW);
  return mocks.enqueueRunEvents.mock.calls.flatMap(
    (call) => call[1] as WorkflowRunEvent[]
  );
}

function launchedSteps(): LaunchStepLoopInput[] {
  return mocks.launchStepLoop.mock.calls.map(
    (call) => call[0] as LaunchStepLoopInput
  );
}

beforeEach(() => {
  resetHarness();
});

function agentStep(
  id: string,
  overrides: Partial<Extract<ProcessStep, { type: "agent" }>> = {}
) {
  return {
    type: ProcessStepType.Agent,
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    instruction: `Do the ${id} work.`,
    ...overrides,
  };
}

const EXPIRED =
  "Failed to authenticate. API Error: 401 OAuth access token has expired.";

/**
 * The step's loop failed on the model provider, its session recorded; it was
 * linked before the run failed.
 */
const PROVIDER_FAILURE: Partial<RunLoopState> = {
  status: LoopStatus.Failed,
  linkedAt: new Date(NOW.getTime() - 60_000),
  sessionId: "session-1",
  error: { code: LoopErrorCode.AuthChallenge, message: EXPIRED },
};

function implementProcess(retry?: { attempts: number }): ProjectProcessInput {
  return {
    toolkit: null,
    steps: [agentStep("plan"), agentStep("implement", { retry })],
  };
}

/** Runs the process up to the failure of its "implement" step. */
async function untilImplementFails(
  process: ProjectProcessInput,
  failure: Partial<RunLoopState> = PROVIDER_FAILURE
) {
  setProcess(process);
  await advance();
  finish(LoopCommand.Step, stepUpload("plan"), "plan");
  await advance();
  finish(LoopCommand.Step, failure, "implement");
}

describe("automatic retry of a step", () => {
  it("waits the backoff, then goes on with the failed session in a fork", async () => {
    await untilImplementFails(implementProcess({ attempts: 2 }));

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepAttempts).toBe(1);
    expect(currentRun().nextStepAt).toBeInstanceOf(Date);
    expect(mocks.launchStepLoop).toHaveBeenCalledTimes(2);

    currentRun().nextStepAt = null;
    const events = await advance();

    expect(events).toEqual([]);
    expect(currentRun()).toMatchObject({
      status: WorkflowRunStatus.Running,
      stepId: "implement",
      stepAttempts: 0,
      stepState: { autoRetry: { stepId: "implement", attempts: 1 } },
    });
    const resumed = launchedSteps()[2];
    expect(resumed).toMatchObject({
      computeTargetId: "runner-1",
      resumeLoopId: "step-2",
      step: { stepId: "implement", fresh: false, forkSession: true },
    });
    expect(resumed?.prompt).toContain(EXPIRED);
  });

  it("fails the run once its automatic retries are used up", async () => {
    await untilImplementFails(implementProcess({ attempts: 1 }));
    await advance();
    currentRun().nextStepAt = null;
    await advance();
    finish(LoopCommand.Step, PROVIDER_FAILURE, "implement");

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      code: WorkflowRunErrorCode.StepFailed,
      message: expect.stringContaining("(gave up after 1 automatic retries)"),
    });
  });

  it("fails at once on any other failure, or without retry settings", async () => {
    await untilImplementFails(implementProcess({ attempts: 2 }), {
      ...PROVIDER_FAILURE,
      error: { code: LoopErrorCode.ProcessFailed, message: "exit code 1" },
    });
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);

    resetHarness();
    await untilImplementFails(implementProcess());
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(mocks.launchStepLoop).toHaveBeenCalledTimes(2);
  });
});

describe("retry of a failed step by an administrator", () => {
  it("resumes the failed session in a fork, in a new cycle", async () => {
    await untilImplementFails(implementProcess());
    await advance();
    const cycle = Number(currentRun().cycle);

    await expect(
      retryRun(ORG_ID, RUN_ID, WorkflowRunRetryMode.Resume)
    ).resolves.toEqual(Result.ok(null));

    expect(currentRun()).toMatchObject({
      status: WorkflowRunStatus.Running,
      stepId: "implement",
      cycle: cycle + 1,
    });
    expect(launchedSteps()[2]).toMatchObject({
      resumeLoopId: "step-2",
      step: { stepId: "implement", forkSession: true },
    });
  });

  it("refuses to resume a step whose session was not recorded", async () => {
    await untilImplementFails(implementProcess(), {
      ...PROVIDER_FAILURE,
      sessionId: null,
    });
    await advance();

    await expect(
      retryRun(ORG_ID, RUN_ID, WorkflowRunRetryMode.Resume)
    ).resolves.toEqual(Result.err({ failure: RetryRunFailure.NotResumable }));
    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
  });

  it("restarts the step in a new session", async () => {
    await untilImplementFails(implementProcess());
    await advance();

    await expect(
      retryRun(ORG_ID, RUN_ID, WorkflowRunRetryMode.Restart)
    ).resolves.toEqual(Result.ok(null));

    const restarted = launchedSteps()[2];
    expect(restarted?.resumeLoopId).toBeUndefined();
    expect(restarted?.step.forkSession).toBeUndefined();
    expect(restarted?.prompt).toBe("Do the implement work.");
  });
});
