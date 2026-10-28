import { SourceOperation } from "@repo/api/src/types/connection-grants";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  type AgentProcessStep,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  WorkflowRunErrorCode,
  WorkflowRunStatus,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runLoopState as loop } from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  settleAgentStep,
  toLoopStepConfig,
} from "@/lib/workflows/engine/agent-step";
import type { EngineRun } from "@/lib/workflows/engine/step-outcome";

/**
 * A process agent step whose `connections:` grant gives its agent
 * integration tools: its STEP loop asks for them (step.integrationTools),
 * and a loop whose runner never opened them (an older runner) fails the run
 * instead of passing as if the agent had acted.
 */

const mocks = vi.hoisted(() => ({
  findLatestRunLoop: vi.fn(),
  findToolSession: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) =>
    fn({ integrationToolSession: { findUnique: mocks.findToolSession } });
  withDb.tx = withDb;
  return { withDb, Prisma: {} };
});
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workflows/engine/run-loops")
  >()),
  findLatestRunLoop: mocks.findLatestRunLoop,
}));

const STEP: AgentProcessStep = {
  type: ProcessStepType.Agent,
  id: "triage",
  name: "Triage",
  instruction: "Triage the ticket and comment on it.",
  questions: ProcessQuestionsPolicy.Continue,
  artifacts: [],
  reply: null,
  document: null,
  finish: ProcessStepFinish.None,
  timeoutMinutes: null,
  connections: { source: [SourceOperation.Comment] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findLatestRunLoop.mockResolvedValue(
    loop({
      loopId: "loop-1",
      command: LoopCommand.Step,
      status: LoopStatus.Completed,
      computeTargetId: "runner-1",
    })
  );
});

describe("toLoopStepConfig", () => {
  it("gives the agent of a step with a grant integration tools", () => {
    expect(
      toLoopStepConfig({
        runId: "run-1",
        step: STEP,
        toolkit: null,
        fresh: true,
      }).integrationTools
    ).toBe(true);
  });

  it("gives a step without a grant none", () => {
    expect(
      toLoopStepConfig({
        runId: "run-1",
        step: { ...STEP, connections: undefined },
        toolkit: null,
        fresh: true,
      })
    ).not.toHaveProperty("integrationTools");
  });
});

describe("settleAgentStep", () => {
  it("fails the run when the step's runner never opened its tools", async () => {
    mocks.findToolSession.mockResolvedValue({ issuedAt: null });

    const settlement = await settleAgentStep(engineRun(), NOW);

    expect(mocks.findToolSession).toHaveBeenCalledWith({
      where: { loopId: "loop-1" },
      select: { issuedAt: true },
    });
    expect(settlement).toMatchObject({
      kind: "outcome",
      outcome: {
        status: WorkflowRunStatus.Failed,
        data: {
          error: {
            code: WorkflowRunErrorCode.StepFailed,
            message: expect.stringContaining(
              '"Triage" step: The runner did not open the agent\'s integration tools'
            ),
          },
        },
      },
    });
  });
});

const NOW = new Date("2026-10-13T10:30:00.000Z");

function engineRun(): EngineRun {
  return {
    id: "run-1",
    organizationId: "org-1",
    workflowId: "wf-1",
    status: WorkflowRunStatus.Running,
    cycle: 1,
    source: null,
    agentConfig: {
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
      computeTargetId: "0199a5f0-0000-7000-8000-0000000000d1",
      repository: null,
      prd: workflowPrdRuleSchema.parse({}),
      instructions: "",
      titleTemplate: "{{source.key}}: {{source.title}}",
      process: null,
    },
    runAsUserId: "user-1",
    connectionId: null,
    featureDocumentId: "issue-1",
    planDocumentId: null,
    phaseStartedAt: new Date("2026-10-13T10:00:00.000Z"),
    stepAttempts: 0,
    process: {
      version: 1,
      source: "workflow",
      definition: { toolkit: null, steps: [STEP] },
    },
    stepId: "triage",
    stepState: null,
    projectId: "project-1",
    projectConnectionId: null,
    workflow: { name: "Support", enabled: true },
  };
}
