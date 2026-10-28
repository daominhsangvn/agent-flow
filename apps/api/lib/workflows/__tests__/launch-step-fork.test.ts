import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchStepLoop } from "@/lib/workflows/engine/launch-step";

/** A forked step launch is refused on a runner without `loopStepForkSession`. */

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  dispatch: vi.fn(),
  createLoop: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ workflowRun: { findFirst: () => Promise.resolve(null) } }),
}));
vi.mock("@/app/integration-tools/integration-tool-session-service", () => ({
  integrationToolSessionService: { openForStep: vi.fn() },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findById: mocks.findById },
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

function targetWith(capabilities: unknown) {
  mocks.findById.mockResolvedValue({
    id: TARGET,
    organizationId: "org-1",
    machineName: "runner-old",
    capabilities,
  });
}

function launch(forkSession: boolean) {
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
      fresh: false,
      forkSession,
      askQuestions: false,
      artifacts: [],
      finish: LoopStepFinish.None,
      toolkit: null,
      integrationTools: false,
    },
    prompt: "Retry.",
    computeTargetId: TARGET,
  });
}

describe("launchStepLoop fork guard", () => {
  it("refuses a fork on a runner without loopStepForkSession", async () => {
    targetWith({});

    const result = await launch(true);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        WorkflowRunErrorCode.ComputeTargetUnavailable
      );
      expect(result.error.message).toContain("runner-old");
    }
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("launches a fork on a runner that forks", async () => {
    targetWith({ loopStepForkSession: true });

    const result = await launch(true);

    expect(result.ok).toBe(true);
    expect(mocks.createLoop).toHaveBeenCalled();
  });

  it("launches without forkSession on a runner that cannot fork", async () => {
    targetWith({});

    const result = await launch(false);

    expect(result.ok).toBe(true);
    expect(mocks.createLoop).toHaveBeenCalled();
  });
});
