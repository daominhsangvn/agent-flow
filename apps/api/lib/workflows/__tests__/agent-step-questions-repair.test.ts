import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  WorkflowRunErrorCode,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runLoopState as loop } from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  questionsRepairPrompt,
  repairStepQuestions,
} from "@/lib/workflows/engine/agent-step-resume";
import type { EngineRun } from "@/lib/workflows/engine/step-outcome";

/**
 * Questions an asking step wrote that could not be read
 * (engine/agent-step-resume.ts repairStepQuestions): the asking session is
 * resumed on its computer to rewrite them within the limits, and the run
 * records the attempt while it stays running.
 */

const mocks = vi.hoisted(() => ({
  launchStepLoop: vi.fn(),
  findLatestRunLoop: vi.fn(),
  listRunLoops: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) => fn({});
  withDb.tx = withDb;
  return { withDb, Prisma: {} };
});
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: mocks.launchStepLoop,
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workflows/engine/run-loops")
  >()),
  findLatestRunLoop: mocks.findLatestRunLoop,
  listRunLoops: mocks.listRunLoops,
}));

const STEP = {
  type: ProcessStepType.Agent,
  id: "analyze",
  name: "Analyze",
  instruction: "/ba-analyze {{issue.file}}",
  questions: ProcessQuestionsPolicy.Ask,
  artifacts: [],
  reply: null,
  document: null,
  finish: ProcessStepFinish.None,
  timeoutMinutes: null,
};

function engineRun(overrides: Partial<EngineRun> = {}): EngineRun {
  return {
    id: "run-1",
    organizationId: "org-1",
    workflowId: "wf-1",
    status: WorkflowRunStatus.Running,
    cycle: 1,
    source: null,
    agentConfig: null,
    runAsUserId: "user-1",
    connectionId: null,
    featureDocumentId: "issue-1",
    planDocumentId: null,
    phaseStartedAt: new Date("2026-10-09T10:00:00.000Z"),
    stepAttempts: 0,
    process: {
      version: 1,
      source: "workflow",
      definition: { toolkit: null, steps: [STEP] },
    },
    stepId: "analyze",
    stepState: null,
    workflow: { name: "BREP", enabled: true, projectId: "project-1" },
    ...overrides,
  };
}

const AGENT: WorkflowAgentConfig = {
  mode: WorkflowAgentMode.PlanAndExecute,
  stopOnOpenQuestions: true,
  computeTargetId: "runner-ipt",
  repository: null,
  instructions: "",
  titleTemplate: "{{source.key}}: {{source.title}}",
  process: null,
};

function input(
  overrides: Partial<Parameters<typeof repairStepQuestions>[0]> = {}
) {
  return {
    run: engineRun(),
    agent: AGENT,
    projectId: "project-1",
    runAsUser: { id: "user-1", clerkId: "clerk-1" },
    step: STEP,
    loopId: "loop-1",
    error: "Too big: expected string to have <=500 characters",
    attempts: 1,
    data: { branchName: "symphony/iss-7" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const asking = loop({
    loopId: "loop-1",
    command: LoopCommand.Step,
    status: LoopStatus.Completed,
    computeTargetId: "runner-ipt",
  });
  mocks.findLatestRunLoop.mockResolvedValue(asking);
  mocks.listRunLoops.mockResolvedValue([asking]);
  mocks.launchStepLoop.mockResolvedValue(
    Result.ok({ loopId: "loop-2", computeTargetId: "runner-ipt" })
  );
});

describe("repairStepQuestions", () => {
  it("resumes the asking session on its computer with the error and the limits, and records the attempt", async () => {
    const outcome = await repairStepQuestions(input());

    expect(mocks.launchStepLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        projectId: "project-1",
        documentId: "issue-1",
        resumeLoopId: "loop-1",
        computeTargetId: "runner-ipt",
        step: expect.objectContaining({ stepId: "analyze", fresh: false }),
        prompt: questionsRepairPrompt(
          "Too big: expected string to have <=500 characters"
        ),
      })
    );
    expect(outcome).toEqual({
      kind: "transition",
      status: WorkflowRunStatus.Running,
      events: [],
      data: {
        branchName: "symphony/iss-7",
        stepState: {
          waiting: null,
          approval: null,
          questionsRepair: { stepId: "analyze", loopId: "loop-1", attempts: 1 },
        },
      },
    });
  });

  it("does not launch a second repair after a crash between the launch and the status write", async () => {
    mocks.findLatestRunLoop.mockResolvedValue(
      loop({ loopId: "loop-2", command: LoopCommand.Step })
    );

    const outcome = await repairStepQuestions(input());

    expect(mocks.launchStepLoop).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "transition",
      status: WorkflowRunStatus.Running,
    });
  });

  it("fails the run when the repair cannot be launched", async () => {
    mocks.launchStepLoop.mockResolvedValue(
      Result.err({
        code: WorkflowRunErrorCode.DispatchFailed,
        message: "No computer",
      })
    );

    const outcome = await repairStepQuestions(input());

    expect(outcome).toMatchObject({
      kind: "transition",
      status: WorkflowRunStatus.Failed,
      data: { error: { message: "No computer" } },
    });
  });

  it("fails the run when its process snapshot cannot be read", async () => {
    const outcome = await repairStepQuestions(
      input({ run: engineRun({ process: null }) })
    );

    expect(mocks.launchStepLoop).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: WorkflowRunStatus.Failed,
      data: { error: { code: WorkflowRunErrorCode.AgentConfigInvalid } },
    });
  });
});

describe("questionsRepairPrompt", () => {
  it("names the file, the error and every limit of the questions file", () => {
    const prompt = questionsRepairPrompt("not JSON");

    expect(prompt).toContain(
      "Your questions could not be read from .agentflow-ai/work/questions.json: not JSON"
    );
    expect(prompt).toContain("at most 30 questions");
    expect(prompt).toContain("each question at most 2000 characters");
    expect(prompt).toContain(
      "at most 10 options per question, each at most 500 characters"
    );
    expect(prompt).toContain("Keep the same questions");
  });
});
