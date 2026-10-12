import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  AgentFlowStepId,
  deriveProcessFromAgentConfig,
  PROCESS_PRESETS,
  ProcessExecuteReview,
  ProcessPlanRecommendations,
  ProcessStepType,
  projectProcessSchema,
  RunProcessSource,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionWithItem,
  runLoopState as loop,
  NOW,
} from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  type AdvanceDbFake,
  AGENT_CONFIG,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  PLAN_DOCUMENT_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { advanceRun } from "@/lib/workflows/engine/advance";
import { PreActionsOutcomeKind } from "@/lib/workflows/engine/pre-actions";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/**
 * A project process equal to the built-in flow must run exactly like a
 * project without one: each scenario runs twice through the real engine
 * (advance.ts, phases.ts), once on the derived flow and once on a stored
 * process, and the observable traces (statuses, events, loops launched, plan
 * approvals, run columns) must be identical.
 */

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  ensureRunDocuments: vi.fn(),
  approvePlanDocument: vi.fn(),
  markIssueInReview: vi.fn(),
  launchWorkflowLoop: vi.fn(),
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
vi.mock("@/lib/workflows/engine/pre-actions", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/pre-actions")>();
  return { ...original, runPreActions: mocks.runPreActions };
});
vi.mock("@/lib/workflows/engine/cancel", () => ({
  cancelRunLoops: mocks.cancelRunLoops,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const OPEN_QUESTIONS = {
  plan: { raw: { openQuestions: [{ question: "Which format?" }] } },
};

const Variant = {
  /** No project process: the built-in flow, derived from the agent config. */
  Derived: "derived",
  /** The project stores a process equal to the built-in flow. */
  Configured: "configured",
} as const;
type Variant = (typeof Variant)[keyof typeof Variant];

type Scenario = {
  agent: WorkflowAgentConfig;
  /** Upload of the PLAN loop (open questions or none). */
  planArtifacts: Record<string, unknown> | null;
  /** Loop someone starts on the plan while the run waits for input. */
  adopt?: LoopCommand;
  /** Step the configured run ends on. */
  finalStep: string;
};

let fake: AdvanceDbFake;
let linkedLoops: RunLoopState[];

function resetHarness() {
  vi.clearAllMocks();
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  linkedLoops = [];
  // Like the real ensureRunDocuments, which saves the ids on the run.
  mocks.ensureRunDocuments.mockImplementation(() => {
    Object.assign(currentRun(), {
      featureDocumentId: FEATURE_DOCUMENT_ID,
      planDocumentId: PLAN_DOCUMENT_ID,
    });
    return Promise.resolve(
      Result.ok({
        featureDocumentId: FEATURE_DOCUMENT_ID,
        planDocumentId: PLAN_DOCUMENT_ID,
      })
    );
  });
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
  mocks.hasPostEvents.mockReturnValue(true);
  mocks.skipUnfinishedPreActionRuns.mockResolvedValue(0);
  mocks.runPreActions.mockResolvedValue({ kind: PreActionsOutcomeKind.Done });
  mocks.loadConnectionRuntime.mockResolvedValue(connectionWithItem());
}

function currentRun() {
  if (!fake.state.run) {
    throw new Error("run expected");
  }
  return fake.state.run;
}

/** Completes the last launched loop of `command` with an upload. */
function complete(
  command: LoopCommand,
  overrides: Partial<RunLoopState> = {}
): void {
  let index = -1;
  linkedLoops.forEach((entry, position) => {
    if (entry.command === command) {
      index = position;
    }
  });
  const entry = linkedLoops[index];
  if (!entry) {
    throw new Error(`no ${command} loop launched`);
  }
  linkedLoops[index] = { ...entry, status: LoopStatus.Completed, ...overrides };
}

/**
 * Runs the scenario from received to the end and records what the engine
 * did after each advance.
 */
async function trace(scenario: Scenario, variant: Variant) {
  resetHarness();
  if (variant === Variant.Configured) {
    fake.state.projectProcess = {
      version: 4,
      definition: deriveProcessFromAgentConfig(scenario.agent),
    };
  }
  fake.setRun({ status: WorkflowRunStatus.Received });
  currentRun().agentConfig = scenario.agent;
  const steps: Array<{
    status: string;
    cycle: number;
    events: WorkflowRunEvent[];
  }> = [];
  const advance = async () => {
    mocks.enqueueRunEvents.mockClear();
    await advanceRun(RUN_ID, NOW);
    steps.push({
      status: currentRun().status,
      cycle: Number(currentRun().cycle),
      events: mocks.enqueueRunEvents.mock.calls.flatMap(
        (call) => call[1] as WorkflowRunEvent[]
      ),
    });
  };

  await advance(); // received -> ingesting -> planning
  complete(LoopCommand.Plan, { uploadedArtifacts: scenario.planArtifacts });
  await advance(); // planning -> succeeded | needs_input | executing
  if (scenario.adopt && currentRun().status === WorkflowRunStatus.NeedsInput) {
    mocks.findAdoptableLoop.mockResolvedValue({
      id: "adopted-1",
      command: scenario.adopt,
    });
    linkedLoops.push(loop({ loopId: "adopted-1", command: scenario.adopt }));
    await advance(); // needs_input -> executing | planning (next cycle)
  }
  if (currentRun().status === WorkflowRunStatus.Executing) {
    complete(LoopCommand.Execute, {
      prUrl: "https://github.com/acme/app/pull/12",
      branchName: "feat/csv",
    });
    await advance(); // executing -> succeeded
  }

  const run = currentRun();
  return {
    observable: {
      steps,
      launched: mocks.launchWorkflowLoop.mock.calls.map((call) => call[0]),
      approvedPlans: mocks.approvePlanDocument.mock.calls,
      issuesInReview: mocks.markIssueInReview.mock.calls,
      adoptedLoops: mocks.recordRunLoop.mock.calls,
      run: {
        status: run.status,
        cycle: run.cycle,
        error: run.error,
        prUrl: run.prUrl,
        branchName: run.branchName,
        completedAt: run.completedAt,
      },
    },
    stepId: (run as { stepId?: string | null }).stepId,
    process: (run as { process?: unknown }).process,
  };
}

const SCENARIOS: [string, Scenario][] = [
  [
    "plan and implement without questions",
    {
      agent: AGENT_CONFIG,
      planArtifacts: null,
      finalStep: AgentFlowStepId.Execute,
    },
  ],
  [
    "plan and implement, stopping for open questions",
    {
      agent: AGENT_CONFIG,
      planArtifacts: OPEN_QUESTIONS,
      finalStep: AgentFlowStepId.Plan,
    },
  ],
  [
    "plan and implement despite open questions when not asked to stop",
    {
      agent: { ...AGENT_CONFIG, stopOnOpenQuestions: false },
      planArtifacts: OPEN_QUESTIONS,
      finalStep: AgentFlowStepId.Execute,
    },
  ],
  [
    "plan only, open questions included in the result",
    {
      agent: { ...AGENT_CONFIG, mode: WorkflowAgentMode.Plan },
      planArtifacts: OPEN_QUESTIONS,
      finalStep: AgentFlowStepId.Plan,
    },
  ],
  [
    "needs input, then an EXECUTE loop started on the plan is adopted",
    {
      agent: AGENT_CONFIG,
      planArtifacts: OPEN_QUESTIONS,
      adopt: LoopCommand.Execute,
      finalStep: AgentFlowStepId.Execute,
    },
  ],
  [
    "needs input, then a new PLAN loop starts the next cycle",
    {
      agent: AGENT_CONFIG,
      planArtifacts: OPEN_QUESTIONS,
      adopt: LoopCommand.Plan,
      finalStep: AgentFlowStepId.Plan,
    },
  ],
];

beforeEach(() => {
  resetHarness();
});

describe("a project process equal to the built-in flow", () => {
  it.each(
    SCENARIOS
  )("runs exactly like the built-in flow: %s", async (_name, scenario) => {
    const derived = await trace(scenario, Variant.Derived);
    const configured = await trace(scenario, Variant.Configured);

    expect(configured.observable).toEqual(derived.observable);
    // The built-in flow writes no process column at all.
    expect(derived.stepId).toBeUndefined();
    expect(derived.process).toBeUndefined();
    // The project process run records its snapshot and current step.
    expect(configured.process).toEqual({
      version: 4,
      source: RunProcessSource.Project,
      definition: deriveProcessFromAgentConfig(scenario.agent),
    });
    expect(configured.stepId).toBe(scenario.finalStep);
  });

  it("follows the expected built-in trace for plan and implement", async () => {
    const { observable } = await trace(
      {
        agent: AGENT_CONFIG,
        planArtifacts: null,
        finalStep: AgentFlowStepId.Execute,
      },
      Variant.Configured
    );

    expect(observable.steps).toEqual([
      {
        status: WorkflowRunStatus.Planning,
        cycle: 1,
        events: [WorkflowRunEvent.Started],
      },
      {
        status: WorkflowRunStatus.Executing,
        cycle: 1,
        events: [WorkflowRunEvent.PlanReady],
      },
      {
        status: WorkflowRunStatus.Succeeded,
        cycle: 1,
        events: [WorkflowRunEvent.Succeeded],
      },
    ]);
    expect(
      observable.launched.map((input: { command: string }) => input.command)
    ).toEqual([LoopCommand.Plan, LoopCommand.Execute]);
  });

  it("keeps a run's snapshot when the project changes its process later", async () => {
    resetHarness();
    fake.state.projectProcess = {
      version: 1,
      definition: deriveProcessFromAgentConfig(AGENT_CONFIG),
    };
    fake.setRun({ status: WorkflowRunStatus.Received });
    await advanceRun(RUN_ID, NOW);
    // The project switches to plan-only while the run is planning.
    fake.state.projectProcess = {
      version: 2,
      definition: deriveProcessFromAgentConfig({
        ...AGENT_CONFIG,
        mode: WorkflowAgentMode.Plan,
      }),
    };
    complete(LoopCommand.Plan);
    await advanceRun(RUN_ID, NOW);

    expect(currentRun().status).toBe(WorkflowRunStatus.Executing);
    expect(currentRun().stepId).toBe(AgentFlowStepId.Execute);
  });

  it("fails clearly when the stored process does not parse", async () => {
    resetHarness();
    fake.state.projectProcess = { version: 3, definition: { steps: [] } };
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);

    expect(currentRun().status).toBe(WorkflowRunStatus.Failed);
    expect(currentRun().error).toMatchObject({
      message: expect.stringContaining("version 3"),
    });
    expect(mocks.launchWorkflowLoop).not.toHaveBeenCalled();
  });
});

describe("process presets", () => {
  it("are valid processes once their toolkit repository is chosen", () => {
    for (const preset of PROCESS_PRESETS) {
      const process = preset.process.toolkit
        ? {
            ...preset.process,
            toolkit: { ...preset.process.toolkit, repository: "acme/toolkit" },
          }
        : preset.process;
      expect(projectProcessSchema.safeParse(process).success).toBe(true);
    }
  });

  it("start the default preset from the built-in flow", () => {
    expect(PROCESS_PRESETS[0]?.process).toEqual(
      deriveProcessFromAgentConfig(AGENT_CONFIG)
    );
  });
});

describe("a process step that changes what its agents decide on their own", () => {
  function launchedPolicies() {
    return mocks.launchWorkflowLoop.mock.calls.map((call) => {
      const input = call[0] as { command: string; agentPolicy?: unknown };
      return [input.command, input.agentPolicy];
    });
  }

  it("sends the plan step's recommendations and the implement step's review with their loops", async () => {
    resetHarness();
    const builtIn = deriveProcessFromAgentConfig(AGENT_CONFIG);
    fake.state.projectProcess = {
      version: 5,
      definition: {
        ...builtIn,
        steps: builtIn.steps.map((step) => {
          if (step.type === ProcessStepType.AgentFlowPlan) {
            return {
              ...step,
              recommendations: ProcessPlanRecommendations.Suggest,
            };
          }
          if (step.type === ProcessStepType.AgentFlowExecute) {
            return { ...step, review: ProcessExecuteReview.Fast };
          }
          return step;
        }),
      },
    };
    fake.setRun({ status: WorkflowRunStatus.Received });

    await advanceRun(RUN_ID, NOW);
    complete(LoopCommand.Plan);
    await advanceRun(RUN_ID, NOW);

    expect(launchedPolicies()).toEqual([
      [
        LoopCommand.Plan,
        { recommendations: ProcessPlanRecommendations.Suggest },
      ],
      [LoopCommand.Execute, { review: ProcessExecuteReview.Fast }],
    ]);
  });

  it("sends no policy on the built-in flow or a process equal to it", async () => {
    for (const variant of [Variant.Derived, Variant.Configured]) {
      await trace(
        {
          agent: AGENT_CONFIG,
          planArtifacts: null,
          finalStep: AgentFlowStepId.Execute,
        },
        variant
      );

      expect(launchedPolicies()).toEqual([
        [LoopCommand.Plan, undefined],
        [LoopCommand.Execute, undefined],
      ]);
    }
  });
});
