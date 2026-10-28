import {
  LOOP_STEP_ARTIFACT_KEY,
  type LoopStepConfig,
  LoopStepFinish,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  AgentFlowStepId,
  ProcessDocumentType,
  ProcessQuestionsPolicy,
  type ProcessStep,
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
  PLAN_DOCUMENT_ID,
  PROJECT_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { advanceRun } from "@/lib/workflows/engine/advance";
import { STEP_ISSUE_FILE } from "@/lib/workflows/engine/agent-step";
import { runError } from "@/lib/workflows/engine/errors";
import type { LaunchStepLoopInput } from "@/lib/workflows/engine/launch-step";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/**
 * Agent steps of a project process (engine/agent-step.ts) through the real
 * engine: each step launches a STEP loop in the run's workspace, a step that
 * asks stops the run with its questions, a pushing step records its branches,
 * and agent steps mix with the AgentFlow plan and implement steps.
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

const TOOLKIT = {
  repository: "acme/speckit",
  mounts: [".claude/skills", ".specify"],
  instructions: "Scripts live in .specify/scripts.",
};

function agentStep(
  id: string,
  overrides: Partial<Extract<ProcessStep, { type: "agent" }>> = {}
) {
  return {
    type: ProcessStepType.Agent,
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    instruction: `/speckit-${id}`,
    ...overrides,
  };
}

const SPEC_KIT: ProjectProcessInput = {
  toolkit: TOOLKIT,
  steps: [
    agentStep("specify", {
      instruction: "/speckit-specify {{issue.title}} ({{issue.key}})",
    }),
    agentStep("clarify", { questions: ProcessQuestionsPolicy.Ask }),
    agentStep("implement", { finish: LoopStepFinish.Push }),
  ],
};

const QUESTIONS = [
  { id: "q1", question: "CSV or TSV?", options: ["CSV", "TSV"] },
];

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

describe("agent steps of a project process", () => {
  it("starts the first step in a fresh workspace on the Issue, with its instruction rendered", async () => {
    setProcess(SPEC_KIT);

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("specify");
    expect(currentRun().process).toMatchObject({ version: 2 });
    expect(events).toEqual([WorkflowRunEvent.Started]);
    expect(mocks.ensureRunDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ withPlanDocument: false })
    );
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
    const [launch] = launchedSteps();
    expect(launch).toMatchObject({
      runId: RUN_ID,
      projectId: PROJECT_ID,
      documentId: FEATURE_DOCUMENT_ID,
      prompt: "/speckit-specify Add CSV export (PROJ-7)",
      computeTargetId: null,
    });
    expect(launch?.step).toEqual({
      runId: RUN_ID,
      stepId: "specify",
      name: "Specify",
      fresh: true,
      askQuestions: false,
      artifacts: [],
      finish: LoopStepFinish.None,
      toolkit: TOOLKIT,
    } satisfies LoopStepConfig);
  });

  it("runs the next step on the same computer, then stops with the step's questions", async () => {
    setProcess(SPEC_KIT);
    await advance();
    finish(LoopCommand.Step, stepUpload("specify"));

    await advance(); // specify -> clarify
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("clarify");
    expect(launchedSteps()[1]).toMatchObject({
      computeTargetId: "runner-1",
      step: { stepId: "clarify", fresh: false, askQuestions: true },
    });

    finish(
      LoopCommand.Step,
      stepUpload("clarify", { questions: QUESTIONS }),
      "clarify"
    );
    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(events).toEqual([WorkflowRunEvent.NeedsInput]);
    expect(currentRun().stepState).toEqual({
      waiting: {
        stepId: "clarify",
        loopId: "step-2",
        questions: QUESTIONS,
        askedAt: NOW.toISOString(),
        answers: null,
        answeredBy: null,
      },
      approval: null,
    });

    // Nothing is adopted while the step waits for its answers.
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(mocks.findAdoptableLoop).not.toHaveBeenCalled();
  });

  it("ends after the pushing step with its branches recorded", async () => {
    setProcess(SPEC_KIT);
    await advance();
    finish(LoopCommand.Step, stepUpload("specify"));
    await advance();
    finish(LoopCommand.Step, stepUpload("clarify"), "clarify");
    await advance(); // no questions -> implement
    expect(currentRun().stepId).toBe("implement");
    expect(currentRun().stepState).toBe("__db_null__");

    const executionResult = {
      schemaVersion: 2,
      results: [
        {
          status: "pushed",
          fullName: "acme/shop",
          branchName: "symphony/iss-7",
          baseBranch: "main",
        },
      ],
    };
    finish(
      LoopCommand.Step,
      {
        ...stepUpload("implement", {}, { executionResult }),
        branchName: "symphony/iss-7",
      },
      "implement"
    );
    const events = await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
    expect(events[0]).toBe(WorkflowRunEvent.ExecuteCompleted);
    expect(events.slice(1)).toEqual([WorkflowRunEvent.Succeeded]);
    expect(currentRun().branchName).toBe("symphony/iss-7");
    expect(mocks.recordRunRepositoryBranches).toHaveBeenCalledWith(
      RUN_ID,
      expect.any(String),
      executionResult.results
    );
    expect(mocks.markIssueInReview).toHaveBeenCalledWith(
      FEATURE_DOCUMENT_ID,
      expect.any(String)
    );
  });

  it("fails the run when a step's loop fails", async () => {
    setProcess(SPEC_KIT);
    await advance();
    finish(LoopCommand.Step, {
      status: LoopStatus.Failed,
      error: { code: "agent_failed", message: "spec script missing" },
    });

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(events).toEqual([WorkflowRunEvent.Failed]);
    expect(currentRun().error).toEqual({
      code: WorkflowRunErrorCode.StepFailed,
      message:
        'The "Specify" step loop ended with status FAILED: spec script missing',
    });
  });

  it("resumes a step once to rewrite unreadable questions, then fails", async () => {
    setProcess({
      toolkit: null,
      steps: [agentStep("clarify", { questions: ProcessQuestionsPolicy.Ask })],
    });
    await advance();
    finish(
      LoopCommand.Step,
      stepUpload("clarify", { questionsError: "Too big" })
    );
    await advance(); // the session is resumed to rewrite them
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(launchedSteps()[1]).toMatchObject({
      resumeLoopId: "step-1",
      prompt: expect.stringContaining("Too big"),
    });

    finish(
      LoopCommand.Step,
      stepUpload("clarify", { questionsError: "not JSON" }),
      "clarify"
    );
    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      code: WorkflowRunErrorCode.StepFailed,
      message: expect.stringContaining("not JSON"),
    });
  });

  it("goes on despite questions when the step does not ask", async () => {
    setProcess({
      toolkit: null,
      steps: [agentStep("review")],
    });
    await advance();
    finish(LoopCommand.Step, stepUpload("review", { questions: QUESTIONS }));

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
  });

  it("runs an agent step between the AgentFlow plan and implement steps", async () => {
    setProcess({
      toolkit: null,
      steps: [
        {
          type: ProcessStepType.AgentFlowPlan,
          id: AgentFlowStepId.Plan,
          name: "Plan",
        },
        agentStep("review", { instruction: "Review the plan." }),
        {
          type: ProcessStepType.AgentFlowExecute,
          id: AgentFlowStepId.Execute,
          name: "Implement",
        },
      ],
    });
    await advance(); // -> planning
    expect(currentRun().status).toBe(WorkflowRunStatus.Planning);
    finish(LoopCommand.Plan);

    const planEvents = await advance(); // plan -> review
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(planEvents).toEqual([WorkflowRunEvent.PlanReady]);
    // The step works in the plan's workspace, where PLAN ran.
    expect(launchedSteps()[0]).toMatchObject({
      documentId: PLAN_DOCUMENT_ID,
      computeTargetId: "ct-1",
      step: { fresh: false },
    });

    finish(LoopCommand.Step, stepUpload("review"));
    const reviewEvents = await advance(); // review -> executing
    expect(currentRun().status).toBe(WorkflowRunStatus.Executing);
    expect(currentRun().stepId).toBe(AgentFlowStepId.Execute);
    expect(reviewEvents).toEqual([WorkflowRunEvent.ExecuteStarted]);
    expect(mocks.approvePlanDocument).toHaveBeenCalledWith(
      PLAN_DOCUMENT_ID,
      expect.any(String)
    );

    finish(LoopCommand.Execute, {
      prUrl: "https://github.com/acme/app/pull/12",
      branchName: "feat/csv",
    });
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
    expect(currentRun().prUrl).toBe("https://github.com/acme/app/pull/12");
  });

  it("keeps the implementation's pull request through an agent step after it", async () => {
    setProcess({
      toolkit: null,
      steps: [
        {
          type: ProcessStepType.AgentFlowPlan,
          id: AgentFlowStepId.Plan,
          name: "Plan",
        },
        {
          type: ProcessStepType.AgentFlowExecute,
          id: AgentFlowStepId.Execute,
          name: "Implement",
        },
        agentStep("notes", { instruction: "Write release notes." }),
      ],
    });
    await advance();
    finish(LoopCommand.Plan);
    await advance(); // -> executing
    finish(LoopCommand.Execute, {
      prUrl: "https://github.com/acme/app/pull/12",
      branchName: "feat/csv",
    });

    await advance(); // -> notes
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().prUrl).toBe("https://github.com/acme/app/pull/12");

    finish(LoopCommand.Step, stepUpload("notes"));
    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
    expect(currentRun().prUrl).toBe("https://github.com/acme/app/pull/12");
    expect(currentRun().branchName).toBe("feat/csv");
  });

  it("does not launch a step twice after a crash between launch and status write", async () => {
    setProcess(SPEC_KIT);
    await advance();
    // The status write of the transition into "clarify" was lost.
    linkedLoops.push(
      loop({ loopId: "step-orphan", command: LoopCommand.Step })
    );
    loopSteps.set("step-orphan", "clarify");
    finish(LoopCommand.Step, stepUpload("specify"), "specify");

    await advance();

    expect(currentRun().stepId).toBe("clarify");
    expect(mocks.launchStepLoop).toHaveBeenCalledTimes(1);
  });

  it("offers the Issue file to instructions", () => {
    expect(STEP_ISSUE_FILE).toBe(".agentflow-ai/work/issue.md");
  });
});

describe("documents published by agent steps", () => {
  const PRD_FILE = ".agentflow-ai/work/prd.md";
  const REPLY_FILE = ".agentflow-ai/work/comment.md";
  const PRD_DOCUMENT = {
    type: ProcessDocumentType.Prd,
    path: PRD_FILE,
    title: "PRD: {{issue.title}}",
  };
  const PRD_PROCESS: ProjectProcessInput = {
    toolkit: null,
    steps: [
      agentStep("prd", {
        artifacts: [".agentflow-ai/work/analysis.md"],
        reply: REPLY_FILE,
        document: PRD_DOCUMENT,
      }),
      agentStep("email"),
    ],
  };
  const PRD_FILES = [
    { path: PRD_FILE, content: "# PRD", truncated: false },
    { path: REPLY_FILE, content: "Done", truncated: false },
  ];

  it("collects the document file, publishes it when the step's loop ends, then goes on", async () => {
    setProcess(PRD_PROCESS);
    await advance();
    // Reply and document first, so they always fit the collected files.
    expect(launchedSteps()[0]?.step.artifacts).toEqual([
      REPLY_FILE,
      PRD_FILE,
      ".agentflow-ai/work/analysis.md",
    ]);
    finish(LoopCommand.Step, stepUpload("prd", { files: PRD_FILES }));

    await advance();

    expect(mocks.publishStepDocument).toHaveBeenCalledWith({
      run: expect.objectContaining({
        id: RUN_ID,
        featureDocumentId: FEATURE_DOCUMENT_ID,
      }),
      projectId: PROJECT_ID,
      step: expect.objectContaining({ id: "prd", document: PRD_DOCUMENT }),
      files: PRD_FILES,
      variables: {
        "issue.key": "PROJ-7",
        "issue.title": "Add CSV export",
        "issue.url": expect.any(String),
      },
    });
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("email");
  });

  it("publishes before stopping for the step's questions", async () => {
    setProcess({
      toolkit: null,
      steps: [
        agentStep("prd", {
          questions: ProcessQuestionsPolicy.Ask,
          document: PRD_DOCUMENT,
        }),
      ],
    });
    await advance();
    finish(
      LoopCommand.Step,
      stepUpload("prd", { files: PRD_FILES, questions: QUESTIONS })
    );

    await advance();

    expect(mocks.publishStepDocument).toHaveBeenCalledTimes(1);
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);
  });

  it("retries the step's settlement when publishing fails, and fails the run after the last attempt", async () => {
    const error = runError(
      WorkflowRunErrorCode.DocumentCreateFailed,
      'The document of the "Prd" step could not be published: deadlock'
    );
    mocks.publishStepDocument.mockResolvedValue(Result.err(error));
    setProcess(PRD_PROCESS);
    await advance();
    finish(LoopCommand.Step, stepUpload("prd", { files: PRD_FILES }));

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("prd");
    expect(currentRun().stepAttempts).toBe(1);
    expect(currentRun().nextStepAt).toBeInstanceOf(Date);

    currentRun().stepAttempts = 5;
    currentRun().nextStepAt = null;
    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toEqual({
      code: WorkflowRunErrorCode.DocumentCreateFailed,
      message: `${error.message} (gave up after 5 attempts)`,
    });
  });
});

/** Runs SPEC_KIT up to the questions of "clarify" (asked by loop step-2). */
async function untilClarifyAsks() {
  setProcess(SPEC_KIT);
  await advance();
  finish(LoopCommand.Step, stepUpload("specify"));
  await advance();
  // The asking loop started before the run went to needs_input.
  const asking = linkedLoops[1];
  if (asking) {
    asking.linkedAt = new Date(NOW.getTime() - 60_000);
  }
  finish(
    LoopCommand.Step,
    stepUpload("clarify", { questions: QUESTIONS }),
    "clarify"
  );
  await advance();
}

function setAnswers(answers: Array<{ id: string; answer: string }>) {
  const state = currentRun().stepState as {
    waiting: Record<string, unknown>;
  };
  currentRun().stepState = {
    ...state,
    waiting: { ...state.waiting, answers, answeredBy: "user-1" },
  };
}

const REVIEW_PROCESS: ProjectProcessInput = {
  toolkit: null,
  steps: [
    agentStep("specify", { artifacts: ["specs/**/*.md"] }),
    {
      type: ProcessStepType.Approval,
      id: "review",
      name: "Review the spec",
      show: ["specify"],
    },
    agentStep("implement", { finish: LoopStepFinish.Push }),
  ],
};

function decide(approved: boolean, comment = "") {
  const state = currentRun().stepState as {
    approval: Record<string, unknown>;
  };
  currentRun().stepState = {
    ...state,
    approval: {
      ...state.approval,
      decision: {
        approved,
        comment,
        decidedBy: "user-1",
        decidedAt: NOW.toISOString(),
      },
    },
  };
}

describe("answers to a waiting agent step", () => {
  it("waits until the questions are answered", async () => {
    await untilClarifyAsks();
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsInput);
    expect(mocks.launchStepLoop).toHaveBeenCalledTimes(2);
  });

  it("resumes the asking session on its computer with the answers given in AgentFlow", async () => {
    await untilClarifyAsks();
    setAnswers([{ id: "q1", answer: "CSV" }]);

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("clarify");
    expect(currentRun().stepState).toBe("__db_null__");
    expect(events).toEqual([]);
    // A new cycle, so the step's next wait notifies again.
    expect(currentRun().cycle).toBe(2);
    const resumed = launchedSteps()[2];
    expect(resumed).toMatchObject({
      computeTargetId: "runner-1",
      resumeLoopId: "step-2",
      documentId: FEATURE_DOCUMENT_ID,
      step: { stepId: "clarify", fresh: false, askQuestions: true },
    });
    expect(resumed?.prompt).toContain("- CSV or TSV?\n  Answer: CSV");

    // The resumed step ends without new questions: on to "implement".
    finish(LoopCommand.Step, stepUpload("clarify"), "clarify");
    await advance();
    expect(currentRun().stepId).toBe("implement");
    expect(launchedSteps()[3]?.step.stepId).toBe("implement");
  });

  it("lets the agent decide the questions left unanswered", async () => {
    await untilClarifyAsks();
    setAnswers([{ id: "other", answer: "ignored" }]);

    await advance();

    expect(launchedSteps()[2]?.prompt).toContain(
      "Answer: (no answer: decide yourself)"
    );
  });

  it("resumes the step with the source item's new comments when it triggers the run again", async () => {
    await untilClarifyAsks();
    const fetchItem = vi.fn();
    mocks.loadConnectionRuntime.mockResolvedValue(
      connectionWithItem(fetchItem)
    );
    fetchItem.mockResolvedValue({
      ...(await fetchItem()),
      comments: [
        {
          author: "Old",
          createdAt: "2026-09-01T00:00:00.000Z",
          bodyMarkdown: "Before the question.",
        },
        {
          author: "Dana",
          createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
          bodyMarkdown: "TSV please.",
        },
      ],
    });
    // The item's update started the run again (ingest.ts resumeRun).
    Object.assign(currentRun(), {
      status: WorkflowRunStatus.Ingesting,
      phaseStartedAt: new Date(NOW.getTime() + 120_000),
    });

    await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("clarify");
    const resumed = launchedSteps()[2];
    expect(resumed).toMatchObject({
      resumeLoopId: "step-2",
      computeTargetId: "runner-1",
    });
    expect(resumed?.prompt).toContain("Dana: TSV please.");
    // The item's update started the new cycle already (ingest.ts resumeRun).
    expect(currentRun().cycle).toBe(1);
    expect(resumed?.prompt).not.toContain("Before the question.");
    expect(resumed?.prompt).toContain(STEP_ISSUE_FILE);
  });
});

describe("approval steps", () => {
  async function untilReview() {
    setProcess(REVIEW_PROCESS);
    await advance();
    finish(LoopCommand.Step, stepUpload("specify"));
    return await advance();
  }

  it("waits for a decision and tells the post actions someone is needed", async () => {
    const events = await untilReview();

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
    expect(events).toEqual([WorkflowRunEvent.NeedsInput]);
    expect(currentRun().stepId).toBe("review");
    expect(currentRun().stepState).toEqual({
      waiting: null,
      approval: {
        stepId: "review",
        requestedAt: NOW.toISOString(),
        decision: null,
      },
    });

    await advance();
    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
  });

  it("goes on with the next step on the same computer once approved", async () => {
    await untilReview();
    decide(true);

    const events = await advance();

    // "implement" pushes: it is the run's implementation.
    expect(events).toEqual([WorkflowRunEvent.ExecuteStarted]);
    expect(currentRun().status).toBe(WorkflowRunStatus.Running);
    expect(currentRun().stepId).toBe("implement");
    expect(currentRun().stepState).toBe("__db_null__");
    expect(currentRun().cycle).toBe(2);
    expect(launchedSteps()[1]).toMatchObject({
      computeTargetId: "runner-1",
      step: { stepId: "implement", fresh: false },
    });
  });

  it("fails the run with the comment once rejected", async () => {
    await untilReview();
    decide(false, "The spec misses the export format.");

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(events).toEqual([WorkflowRunEvent.Failed]);
    expect(currentRun().error).toEqual({
      code: WorkflowRunErrorCode.ApprovalRejected,
      message:
        '"Review the spec" was rejected: The spec misses the export format.',
    });
    expect(mocks.launchStepLoop).toHaveBeenCalledTimes(1);
  });

  it("succeeds when an approved approval is the last step", async () => {
    setProcess({
      toolkit: null,
      steps: [
        agentStep("specify"),
        {
          type: ProcessStepType.Approval,
          id: "review",
          name: "Review",
          show: [],
        },
      ],
    });
    await advance();
    finish(LoopCommand.Step, stepUpload("specify"));
    await advance();
    decide(true);

    const events = await advance();

    expect(currentRun().status).toBe(WorkflowRunStatus.Succeeded);
    expect(events).toEqual([WorkflowRunEvent.Succeeded]);
  });

  it("notifies each wait of the run in its own cycle: the questions, then the approval", async () => {
    setProcess({
      toolkit: null,
      steps: [
        agentStep("clarify", { questions: ProcessQuestionsPolicy.Ask }),
        {
          type: ProcessStepType.Approval,
          id: "review",
          name: "Review",
          show: ["clarify"],
        },
        agentStep("implement", { finish: LoopStepFinish.Push }),
      ],
    });
    const waitCycles: number[] = [];
    const advanceAndRecordWaits = async () => {
      await advance();
      for (const [runRef, events] of mocks.enqueueRunEvents.mock.calls) {
        if (
          (events as WorkflowRunEvent[]).includes(WorkflowRunEvent.NeedsInput)
        ) {
          waitCycles.push((runRef as { cycle: number }).cycle);
        }
      }
    };

    await advanceAndRecordWaits(); // -> clarify
    // The asking loop started before the run went to needs_input.
    const asking = linkedLoops[0];
    if (asking) {
      asking.linkedAt = new Date(NOW.getTime() - 60_000);
    }
    finish(LoopCommand.Step, stepUpload("clarify", { questions: QUESTIONS }));
    await advanceAndRecordWaits(); // -> its questions
    setAnswers([{ id: "q1", answer: "CSV" }]);
    await advanceAndRecordWaits(); // -> clarify again
    finish(LoopCommand.Step, stepUpload("clarify"), "clarify");
    await advanceAndRecordWaits(); // -> the approval

    expect(currentRun().status).toBe(WorkflowRunStatus.NeedsApproval);
    // Post actions run once per (event, cycle): the approval would be dropped
    // in the cycle of the questions.
    expect(waitCycles).toEqual([1, 2]);
  });
});
