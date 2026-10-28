import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import { workflowPrdRuleSchema } from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchStepLoop } from "@/lib/workflows/engine/launch-step";

/**
 * A step whose grant gives its agent integration tools gets its loop's tool
 * session opened, on the loop's computer, before the loop is dispatched: the
 * runner asks for its token as soon as the loop starts.
 */

const mocks = vi.hoisted(() => ({
  openForStep: vi.fn(),
  dispatch: vi.fn(),
  createLoop: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ workflowRun: { findFirst: () => Promise.resolve(null) } }),
}));
vi.mock("@/app/integration-tools/integration-tool-session-service", () => ({
  integrationToolSessionService: { openForStep: mocks.openForStep },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findById: () => Promise.resolve(null) },
}));
vi.mock("@/app/loops/service", () => ({
  loopsService: { create: mocks.createLoop },
}));
vi.mock(
  "@/app/projects/project-repository-checkouts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/projects/project-repository-checkouts")
    >()),
    listProjectRepositoryCheckouts: () =>
      Promise.resolve([
        {
          id: "repo-1",
          connectionId: "conn-git",
          provider: "local_git",
          externalId: "acme/api",
          fullName: "acme/api",
          name: "api",
          defaultBranch: "main",
          webUrl: "https://git.test/acme/api",
          cloneUrl: "https://git.test/acme/api.git",
          isPrimary: true,
        },
      ]),
  })
);
vi.mock("@/lib/loops/launch-harness", () => ({
  resolveLaunchHarness: () => Promise.resolve("claude"),
}));
vi.mock("@/lib/loops/loop-dispatch-utils", () => ({
  dispatchAndClassify: mocks.dispatch,
}));
vi.mock("@/lib/workflows/engine/launch", () => ({
  cancelBlockedLoop: vi.fn(),
  checkCommandSigning: () => Promise.resolve(Result.ok(null)),
  dispatchError: vi.fn(),
  mapLoopCreateError: vi.fn(),
  resolveProjectComputeTarget: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", () => ({
  recordRunLoop: () => Promise.resolve(),
}));
vi.mock("@/lib/workflows/engine/run-repository", () => ({
  recordRunRepositories: () => Promise.resolve(),
}));

const TARGET = "0199a5f0-0000-7000-8000-0000000000d1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLoop.mockResolvedValue({
    loopId: "loop-1",
    status: LoopStatus.Pending,
  });
  mocks.dispatch.mockResolvedValue({ ok: true });
});

function launch(integrationTools: boolean) {
  return launchStepLoop({
    runId: "run-1",
    organizationId: "org-1",
    projectId: "project-1",
    runAsUser: { id: "user-1", clerkId: "clerk-1" },
    documentId: "issue-1",
    agent: {
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
      computeTargetId: TARGET,
      runners: [],
      repository: null,
      prd: workflowPrdRuleSchema.parse({}),
      instructions: "",
      titleTemplate: "{{source.key}}",
      process: null,
    },
    step: {
      runId: "run-1",
      stepId: "triage",
      name: "Triage",
      fresh: true,
      askQuestions: false,
      artifacts: [],
      finish: LoopStepFinish.None,
      toolkit: null,
      integrationTools,
    },
    prompt: "Triage the ticket.",
    computeTargetId: TARGET,
  });
}

describe("launchStepLoop", () => {
  it("opens the loop's tool session on its computer before the dispatch", async () => {
    const result = await launch(true);

    expect(result).toEqual({
      ok: true,
      value: { loopId: "loop-1", computeTargetId: TARGET },
    });
    expect(mocks.openForStep).toHaveBeenCalledWith({
      organizationId: "org-1",
      runId: "run-1",
      loopId: "loop-1",
      stepId: "triage",
      computeTargetId: TARGET,
      expiresAt: expect.any(Date),
    });
    expect(mocks.openForStep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatch.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("opens no session for a step without tools", async () => {
    await launch(false);

    expect(mocks.openForStep).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalled();
  });
});
