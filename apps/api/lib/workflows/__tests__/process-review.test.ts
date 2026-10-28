import {
  LOOP_STEP_ARTIFACT_KEY,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ProcessQuestionsPolicy,
  ProcessStepRole,
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
  type ReviewDecision,
  ReviewDecisionKind,
  ReviewSession,
  ReviewSignalVia,
  type RunStepState,
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
import type { LaunchStepLoopInput } from "@/lib/workflows/engine/launch-step";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/**
 * Review loops (docs/workflows.md "Review loops") through the real engine: a
 * reviewed step waits after its work, then goes on once approved, runs again
 * with the feedback (resuming its session, the label removed), or fails when
 * rejected; signals that arrived while it worked decide it at once.
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
  removeSourceLabel: vi.fn(),
  readFeedbackComments: vi.fn(),
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
vi.mock("@/lib/workflows/engine/source-connection", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/workflows/engine/source-connection")
    >();
  return {
    ...original,
    removeSourceLabel: mocks.removeSourceLabel,
    readFeedbackComments: mocks.readFeedbackComments,
  };
});

function agentStep(
  id: string,
  overrides: Partial<
    Extract<ProjectProcessInput["steps"][number], { type: "agent" }>
  > = {}
) {
  return {
    type: ProcessStepType.Agent,
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    instruction: `/team-${id} {{issue.key}}`,
    ...overrides,
  };
}

const REVIEWED: ProjectProcessInput = {
  toolkit: null,
  steps: [
    agentStep("plan", {
      role: ProcessStepRole.Plan,
      questions: ProcessQuestionsPolicy.Ask,
      review: {
        approve: { labels: ["plan-approved"] },
        feedback: { labels: ["replan"], mention: true },
        instruction: "Replan with: {{feedback.text}}",
      },
    }),
    agentStep("implement", {
      role: ProcessStepRole.Implement,
      review: { complete: { labels: ["done"] } },
    }),
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
  mocks.removeSourceLabel.mockResolvedValue(true);
  mocks.readFeedbackComments.mockResolvedValue("Bea: split the export task");
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

/** Writes a decision on the waiting review, as the route or a signal would. */
function decide(
  decision: Partial<ReviewDecision> & Pick<ReviewDecision, "kind">
) {
  const state = currentRun().stepState as RunStepState;
  if (!state.review) {
    throw new Error("review expected");
  }
  currentRun().stepState = {
    ...state,
    review: {
      ...state.review,
      decision: {
        via: ReviewSignalVia.App,
        text: "",
        by: "user-1",
        author: null,
        label: null,
        at: NOW.toISOString(),
        ...decision,
      },
    },
  };
}

async function reachPlanReview() {
  setProcess(REVIEWED);
  await advance();
  finishStep("plan", { files: [planFile()] });
  return await advance();
}

describe("a reviewed step", () => {
  it("waits for its review after its work, round 1, notifying people", async () => {
    const events = await reachPlanReview();

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
    expect(events).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.NeedsInput,
    ]);
    expect(currentRun().stepState).toEqual({
      waiting: null,
      approval: null,
      review: {
        stepId: "plan",
        loopId: "step-1",
        round: 1,
        requestedAt: NOW.toISOString(),
        decision: null,
        history: [],
      },
    });
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
  });

  it("approves the plan and goes on with the next step in a new cycle", async () => {
    await reachPlanReview();
    decide({ kind: ReviewDecisionKind.Approve });

    const events = await advance();

    expect(mocks.approvePlanDocument).toHaveBeenCalledWith(
      PLAN_DOCUMENT_ID,
      ORG_ID
    );
    expect(currentRun().stepId).toBe("implement");
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().cycle).toBe(2);
    expect(events).toEqual([WorkflowRunEvent.ExecuteStarted]);
  });

  it("runs the step again with feedback given in AgentFlow, resuming its session", async () => {
    await reachPlanReview();
    decide({
      kind: ReviewDecisionKind.Feedback,
      text: "Split the export task in two",
    });

    const events = await advance();

    expect(events).toEqual([WorkflowRunEvent.PlanStarted]);
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().cycle).toBe(2);
    const round = launchedSteps()[1];
    expect(round).toMatchObject({
      resumeLoopId: "step-1",
      computeTargetId: "runner-1",
      step: { stepId: "plan", fresh: false },
    });
    expect(round?.prompt).toContain("Split the export task in two");
    expect(round?.prompt).toContain(
      "Replan with: Split the export task in two"
    );
    expect(mocks.readFeedbackComments).not.toHaveBeenCalled();
    expect(mocks.removeSourceLabel).not.toHaveBeenCalled();

    finishStep("plan", { files: [planFile("# Plan v2")] });
    await advance();

    const state = currentRun().stepState as RunStepState;
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
    expect(state.review).toMatchObject({
      round: 2,
      loopId: "step-2",
      decision: null,
      history: [
        {
          kind: ReviewDecisionKind.Feedback,
          text: "Split the export task in two",
        },
      ],
    });
  });

  it("reads the comments of a label feedback and removes the label", async () => {
    await reachPlanReview();
    decide({
      kind: ReviewDecisionKind.Feedback,
      via: ReviewSignalVia.Label,
      label: "replan",
      author: "Bea",
      by: null,
    });

    await advance();

    expect(mocks.readFeedbackComments).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID }),
      expect.anything(),
      { after: null, until: NOW.toISOString() }
    );
    expect(mocks.removeSourceLabel).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID }),
      "replan",
      `${RUN_ID}:review:1`
    );
    expect(launchedSteps()[1]?.prompt).toContain("Bea: split the export task");
    expect(launchedSteps()[1]?.prompt).toContain(
      'by adding the label "replan" to the item'
    );
  });

  it("starts a new session for a fresh review", async () => {
    setProcess({
      toolkit: null,
      steps: [
        agentStep("plan", {
          role: ProcessStepRole.Plan,
          review: { session: ReviewSession.Fresh },
        }),
      ],
    });
    await advance();
    finishStep("plan", { files: [planFile()] });
    await advance();
    decide({ kind: ReviewDecisionKind.Feedback, text: "More detail" });

    await advance();

    const round = launchedSteps()[1];
    expect(round).not.toHaveProperty("resumeLoopId");
    expect(round?.prompt).toContain("/team-plan PROJ-7");
    expect(round?.prompt).toContain("More detail");
  });

  it("fails the run when the review is rejected", async () => {
    await reachPlanReview();
    decide({ kind: ReviewDecisionKind.Reject, text: "Out of scope" });

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      code: WorkflowRunErrorCode.ReviewRejected,
      message: 'The "Plan" step was rejected: Out of scope',
    });
  });

  it("is decided at once by a signal that arrived while it worked, without notifying a wait", async () => {
    setProcess(REVIEWED);
    await advance();
    finishStep("plan", { files: [planFile()] });
    currentRun().stepState = {
      waiting: null,
      approval: null,
      pendingSignals: [
        {
          kind: ReviewDecisionKind.Approve,
          via: ReviewSignalVia.Label,
          text: "",
          by: null,
          author: "Bea",
          label: "plan-approved",
          at: NOW.toISOString(),
        },
      ],
    };

    const events = await advance();

    expect(events).not.toContain(WorkflowRunEvent.NeedsInput);
    expect(currentRun().stepId).toBe("implement");
  });

  it("ends the run when the last step's review is complete", async () => {
    await reachPlanReview();
    decide({ kind: ReviewDecisionKind.Approve });
    await advance();
    finishStep("implement");
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
    decide({ kind: ReviewDecisionKind.Approve });

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
    expect(events).toEqual([WorkflowRunEvent.Succeeded]);
  });
});
