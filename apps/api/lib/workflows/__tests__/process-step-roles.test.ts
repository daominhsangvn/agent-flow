import {
  LOOP_STEP_ARTIFACT_KEY,
  type LoopStepConfig,
  LoopStepFinish,
  type LoopStepResult,
  LoopStepRole,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ProcessQuestionsPolicy,
  type ProcessStep,
  ProcessStepRole,
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  WorkflowRunEvent,
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
import { advanceRun } from "@/lib/workflows/engine/advance";
import { STEP_PLAN_FILE } from "@/lib/workflows/engine/agent-step";
import { planRepairPrompt } from "@/lib/workflows/engine/agent-step-resume";
import type { LaunchStepLoopInput } from "@/lib/workflows/engine/launch-step";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";
import { STEP_RELEASE_NOTES_FILE } from "@/lib/workflows/engine/step-documents";

/**
 * Step roles of a project process (docs/workflows.md "Step roles") through
 * the real engine: a plan step's plan becomes a version of the run's plan
 * document (asked again once when it is missing), and an implement step
 * approves that plan, pushes and publishes its release notes.
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
  publishReleaseNotes: vi.fn(),
  publishRunPlanVersion: vi.fn(),
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
vi.mock("@/lib/workflows/engine/step-documents", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/workflows/engine/step-documents")
    >();
  return {
    ...original,
    publishStepDocument: mocks.publishStepDocument,
    publishReleaseNotes: mocks.publishReleaseNotes,
    publishRunPlanVersion: mocks.publishRunPlanVersion,
  };
});
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

function agentStep(
  id: string,
  overrides: Partial<Extract<ProcessStep, { type: "agent" }>> = {}
) {
  return {
    type: ProcessStepType.Agent,
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    instruction: `/team-${id} {{issue.key}}`,
    ...overrides,
  };
}

const PLAN_AND_IMPLEMENT: ProjectProcessInput = {
  toolkit: null,
  steps: [
    agentStep("plan", {
      role: ProcessStepRole.Plan,
      questions: ProcessQuestionsPolicy.Ask,
    }),
    agentStep("implement", { role: ProcessStepRole.Implement }),
  ],
};

const PLAN_MARKDOWN = "# Plan\n\n- [ ] Add the export button\n";

let fake: AdvanceDbFake;
let linkedLoops: RunLoopState[];
/** Step of each STEP loop (workflow_run_loops.step_id). */
let loopSteps: Map<string, string>;

beforeEach(() => {
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
  mocks.publishReleaseNotes.mockResolvedValue(Result.ok(null));
  mocks.publishRunPlanVersion.mockResolvedValue(Result.ok(null));
});

function currentRun() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

function setProcess(process: ProjectProcessInput) {
  fake.state.projectProcess = {
    version: 3,
    definition: projectProcessSchema.parse(process),
  };
  fake.setRun({ status: WorkflowRunStatus.Received });
}

/** Ends the last STEP loop of `stepId` with `result` as its uploaded outputs. */
function finishStep(
  stepId: string,
  result: Partial<LoopStepResult> = {},
  extra: Record<string, unknown> = {}
): void {
  let index = -1;
  linkedLoops.forEach((entry, position) => {
    if (loopSteps.get(entry.loopId) === stepId) {
      index = position;
    }
  });
  const entry = linkedLoops[index];
  if (!entry) {
    throw new Error(`no loop of the ${stepId} step`);
  }
  linkedLoops[index] = {
    ...entry,
    status: LoopStatus.Completed,
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

function planFile(content = PLAN_MARKDOWN) {
  return { path: STEP_PLAN_FILE, content, truncated: false };
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

describe("a plan step (role: plan)", () => {
  it("gives the run a plan document, works on it with the Issue next to it, and reports plan.started", async () => {
    setProcess(PLAN_AND_IMPLEMENT);

    const events = await advance();

    expect(mocks.ensureRunDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ withPlanDocument: true })
    );
    expect(events).toEqual([
      WorkflowRunEvent.Started,
      WorkflowRunEvent.PlanStarted,
    ]);
    const [launch] = launchedSteps();
    expect(launch).toMatchObject({
      documentId: PLAN_DOCUMENT_ID,
      sourceDocumentId: FEATURE_DOCUMENT_ID,
      prompt: "/team-plan PROJ-7",
    });
    expect(launch?.step).toEqual({
      runId: RUN_ID,
      stepId: "plan",
      name: "Plan",
      fresh: true,
      askQuestions: true,
      artifacts: [STEP_PLAN_FILE],
      finish: LoopStepFinish.None,
      toolkit: null,
      role: LoopStepRole.Plan,
    } satisfies LoopStepConfig);
  });

  it("keeps the plan it wrote as a version of the run's plan, reports plan.completed and goes on", async () => {
    setProcess(PLAN_AND_IMPLEMENT);
    await advance();
    finishStep("plan", { files: [planFile()] });

    const events = await advance();

    expect(mocks.publishRunPlanVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          id: RUN_ID,
          planDocumentId: PLAN_DOCUMENT_ID,
        }),
        step: expect.objectContaining({ id: "plan" }),
        file: planFile(),
      })
    );
    expect(events).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.ExecuteStarted,
    ]);
    expect(currentRun().stepId).toBe("implement");
  });

  it("asks the session once to write a plan it did not write, then fails the step", async () => {
    setProcess(PLAN_AND_IMPLEMENT);
    await advance();
    finishStep("plan");

    const events = await advance();

    expect(events).toEqual([]);
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepState).toEqual({
      waiting: null,
      approval: null,
      outputRepair: { stepId: "plan", loopId: "step-1", attempts: 1 },
    });
    expect(launchedSteps()[1]).toMatchObject({
      resumeLoopId: "step-1",
      computeTargetId: "runner-1",
      prompt: planRepairPrompt(),
      step: { stepId: "plan", fresh: false },
    });

    finishStep("plan");
    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      code: WorkflowRunErrorCode.StepFailed,
      message: `The "Plan" step did not write the plan to ${STEP_PLAN_FILE}, also after it was asked to.`,
    });
    expect(mocks.approvePlanDocument).not.toHaveBeenCalled();
  });

  it("stops for its questions without a plan, and keeps a draft plan it wrote with them", async () => {
    setProcess(PLAN_AND_IMPLEMENT);
    await advance();
    const questions = [{ id: "q1", question: "CSV or TSV?" }];
    finishStep("plan", { questions, files: [planFile("# Draft")] });

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(events).toEqual([WorkflowRunEvent.NeedsInput]);
    expect(mocks.publishRunPlanVersion).toHaveBeenCalledWith(
      expect.objectContaining({ file: planFile("# Draft") })
    );
    expect(launchedSteps()).toHaveLength(1);
  });
});

describe("an implement step (role: implement)", () => {
  async function reachImplement() {
    setProcess(PLAN_AND_IMPLEMENT);
    await advance();
    finishStep("plan", { files: [planFile()] });
    await advance();
  }

  it("approves the plan, then pushes and collects its release notes first", async () => {
    await reachImplement();

    expect(mocks.approvePlanDocument).toHaveBeenCalledWith(
      PLAN_DOCUMENT_ID,
      ORG_ID
    );
    const implement = launchedSteps()[1];
    expect(implement).toMatchObject({
      documentId: PLAN_DOCUMENT_ID,
      sourceDocumentId: FEATURE_DOCUMENT_ID,
    });
    expect(implement?.step).toMatchObject({
      stepId: "implement",
      finish: LoopStepFinish.Push,
      role: LoopStepRole.Implement,
      releaseNotes: true,
      artifacts: [STEP_RELEASE_NOTES_FILE],
    });
  });

  it("publishes its release notes and ends the run as the implementation", async () => {
    await reachImplement();
    const notes = {
      path: STEP_RELEASE_NOTES_FILE,
      content: "## What changed\nCSV export",
      truncated: false,
    };
    finishStep("implement", { files: [notes] });

    const events = await advance();

    expect(mocks.publishReleaseNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ id: "implement" }),
        files: [notes],
      })
    );
    expect(mocks.markIssueInReview).toHaveBeenCalled();
    expect(events).toEqual([
      WorkflowRunEvent.ExecuteCompleted,
      WorkflowRunEvent.Succeeded,
    ]);
    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
  });

  it("writes no release notes when they are turned off", async () => {
    setProcess({
      toolkit: null,
      steps: [
        agentStep("plan", { role: ProcessStepRole.Plan }),
        agentStep("implement", {
          role: ProcessStepRole.Implement,
          releaseNotes: false,
        }),
      ],
    });
    await advance();
    finishStep("plan", { files: [planFile()] });
    await advance();
    finishStep("implement");
    await advance();

    expect(launchedSteps()[1]?.step).not.toHaveProperty("releaseNotes");
    expect(mocks.publishReleaseNotes).not.toHaveBeenCalled();
    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
  });

  it("fails before launching when the plan cannot be approved", async () => {
    mocks.approvePlanDocument.mockRejectedValue(new Error("plan deleted"));
    await reachImplement();

    expect(launchedSteps()).toHaveLength(1);
    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      code: WorkflowRunErrorCode.PlanStateUnavailable,
    });
  });
});
