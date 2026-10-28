import { PlanRecommendations } from "@agentflow-ai/loops-api/context-pack";
import { HarnessType } from "@repo/api/src/types/compute-target";
import {
  LoopCommand,
  LoopStatus,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import {
  WorkflowRunErrorCode,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrentLoopLimitError,
  LoopAlreadyActiveError,
  RepoNotInProjectPoolError,
} from "@/app/loops/loop-errors";
import { ProjectRunnerChoiceKind } from "@/app/projects/project-runner-selection";
import { CommandSigningRequirementStatus } from "@/lib/compute-target-signing-eligibility";
import {
  type LaunchWorkflowLoopInput,
  launchWorkflowLoop,
} from "@/lib/workflows/engine/launch";

const mocks = vi.hoisted(() => ({
  findWithRegenerationContext: vi.fn(),
  resolveComputeTargetWithPreferences: vi.fn(),
  findTargetById: vi.fn(),
  resolveCommandSigningRequirement: vi.fn(),
  resolveLoopContext: vi.fn(),
  getCommandHandler: vi.fn(),
  resolveLaunchHarness: vi.fn(),
  createLoop: vi.fn(),
  cancelLoop: vi.fn(),
  findParent: vi.fn(),
  dispatchAndClassify: vi.fn(),
  recordRunLoop: vi.fn(),
  chooseProjectRunner: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/app/projects/project-runner-selection", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/projects/project-runner-selection")
  >()),
  chooseProjectRunner: mocks.chooseProjectRunner,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/documents/generation-service", () => ({
  documentGenerationService: {
    findWithRegenerationContext: mocks.findWithRegenerationContext,
  },
}));
vi.mock("@/lib/loops/compute-target-resolver", () => ({
  resolveComputeTargetWithPreferences:
    mocks.resolveComputeTargetWithPreferences,
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findById: mocks.findTargetById },
}));
vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...original,
    resolveCommandSigningRequirement: mocks.resolveCommandSigningRequirement,
  };
});
vi.mock("@/app/documents/[id]/run-loop/run-loop-helpers", () => ({
  resolveLoopContext: mocks.resolveLoopContext,
}));
vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: mocks.getCommandHandler,
}));
vi.mock("@/lib/loops/launch-harness", () => ({
  resolveLaunchHarness: mocks.resolveLaunchHarness,
}));
vi.mock("@/app/loops/service", () => ({
  loopsService: {
    create: mocks.createLoop,
    cancel: mocks.cancelLoop,
    findLatestStateBearingDesktopForArtifact: mocks.findParent,
  },
}));
vi.mock("@/lib/loops/loop-dispatch-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/loops/loop-dispatch-utils")>();
  return { ...original, dispatchAndClassify: mocks.dispatchAndClassify };
});
vi.mock("@/lib/loops/prompts", () => ({
  buildLoopPrompt: (command: string) => `prompt for ${command}`,
}));
vi.mock("@/lib/workflows/engine/run-loops", () => ({
  recordRunLoop: mocks.recordRunLoop,
}));

const TARGET_ID = "0199a5f0-0000-7000-8000-0000000000c1";
const PARENT_TARGET_ID = "0199a5f0-0000-7000-8000-0000000000c2";
const ARTIFACT = { id: "plan-1", project: { id: "p-1" }, sourcePrd: null };

const baseInput: LaunchWorkflowLoopInput = {
  runId: "run-1",
  organizationId: "org-1",
  runAsUser: { id: "user-1", clerkId: "auth-1" },
  planDocumentId: "plan-1",
  command: LoopCommand.Plan,
  agent: {
    mode: WorkflowAgentMode.PlanAndExecute,
    stopOnOpenQuestions: true,
    computeTargetId: TARGET_ID,
    runners: [],
    repository: { fullName: "acme/app", branch: "develop" },
    prd: workflowPrdRuleSchema.parse({}),
    instructions: "",
    titleTemplate: "{{source.key}}",
    process: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.findWithRegenerationContext.mockResolvedValue(ARTIFACT);
  mocks.chooseProjectRunner.mockResolvedValue({ kind: "none" });
  mocks.resolveComputeTargetWithPreferences.mockResolvedValue({
    ok: true,
    computeTargetId: TARGET_ID,
  });
  mocks.findTargetById.mockResolvedValue({
    organizationId: "org-1",
    userId: "owner-1",
    gatewayId: "gw-1",
    capabilities: {},
    user: { clerkId: "auth-owner" },
  });
  mocks.resolveCommandSigningRequirement.mockResolvedValue({
    status: CommandSigningRequirementStatus.NotRequired,
  });
  mocks.getCommandHandler.mockReturnValue({ requiresRepo: true });
  mocks.resolveLoopContext.mockResolvedValue({
    targetRepo: "acme/app",
    targetBranch: "develop",
    contextRefs: [{ sourceId: "feat-1", include: "full" }],
    parentLoopId: undefined,
    additionalRepos: undefined,
  });
  mocks.resolveLaunchHarness.mockResolvedValue(HarnessType.Claude);
  mocks.createLoop.mockResolvedValue({
    loopId: "loop-1",
    status: LoopStatus.Pending,
  });
  mocks.recordRunLoop.mockImplementation(() => {
    mocks.calls.push("record");
    return Promise.resolve();
  });
  mocks.dispatchAndClassify.mockImplementation(() => {
    mocks.calls.push("dispatch");
    return Promise.resolve({ ok: true });
  });
});

describe("launchWorkflowLoop — PLAN", () => {
  it("creates the loop, links it to the run, then dispatches", async () => {
    const result = await launchWorkflowLoop(baseInput);

    expect(result).toEqual({
      ok: true,
      value: { loopId: "loop-1", computeTargetId: TARGET_ID },
    });
    expect(mocks.resolveComputeTargetWithPreferences).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      TARGET_ID
    );
    expect(mocks.resolveLoopContext).toHaveBeenCalledWith(
      ARTIFACT,
      {
        command: RunLoopCommand.Plan,
        repo: { fullName: "acme/app", branch: "develop" },
      },
      { requiresRepo: true },
      "org-1",
      "user-1",
      "plan-1",
      TARGET_ID
    );
    expect(mocks.createLoop).toHaveBeenCalledWith("org-1", "user-1", {
      command: LoopCommand.Plan,
      harness: HarnessType.Claude,
      documentId: "plan-1",
      parentLoopId: undefined,
      computeTargetId: TARGET_ID,
      prompt: `prompt for ${LoopCommand.Plan}`,
      repo: { fullName: "acme/app", branch: "develop" },
      additionalRepos: undefined,
      contextRefs: [{ sourceId: "feat-1", include: "full" }],
      metadata: { workflowRunId: "run-1" },
    });
    expect(mocks.recordRunLoop).toHaveBeenCalledWith({
      organizationId: "org-1",
      runId: "run-1",
      loopId: "loop-1",
      command: LoopCommand.Plan,
      adopted: false,
    });
    expect(mocks.calls).toEqual(["record", "dispatch"]);
    expect(mocks.dispatchAndClassify).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "workflow-engine",
      { workflowRunId: "run-1", documentId: "plan-1" }
    );
  });

  it("keeps the step's agent policy in the loop's metadata", async () => {
    await launchWorkflowLoop({
      ...baseInput,
      agentPolicy: { recommendations: PlanRecommendations.Suggest },
    });

    expect(mocks.createLoop).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({
        metadata: {
          workflowRunId: "run-1",
          agentPolicy: { recommendations: PlanRecommendations.Suggest },
        },
      })
    );
  });

  it("fails when the compute target is not usable", async () => {
    mocks.resolveComputeTargetWithPreferences.mockResolvedValue({
      ok: false,
      error: "compute_target_offline",
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.ComputeTargetUnavailable },
    });
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it.each([
    CommandSigningRequirementStatus.Required,
    CommandSigningRequirementStatus.Unknown,
  ])("fails closed when signing is %s", async (status) => {
    mocks.resolveCommandSigningRequirement.mockResolvedValue({ status });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.SigningRequired },
    });
    expect(mocks.resolveCommandSigningRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: "owner-1",
        requesterUserId: "user-1",
        targetOwnerClerkUserId: "auth-owner",
      })
    );
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("fails without a repository when the command needs one", async () => {
    mocks.resolveLoopContext.mockResolvedValue({
      targetRepo: undefined,
      targetBranch: "main",
      contextRefs: [],
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.NoRepository },
    });
  });

  it("never dispatches a BLOCKED loop and cancels it", async () => {
    mocks.createLoop.mockResolvedValue({
      loopId: "loop-b",
      status: LoopStatus.Blocked,
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.DocumentBlocked },
    });
    expect(mocks.cancelLoop).toHaveBeenCalledWith("loop-b", "org-1");
    expect(mocks.dispatchAndClassify).not.toHaveBeenCalled();
    expect(mocks.recordRunLoop).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ConcurrentLoopLimitError(10, 10),
      WorkflowRunErrorCode.ConcurrencyLimit,
    ],
    [
      new LoopAlreadyActiveError("l", LoopCommand.Plan, LoopStatus.Running),
      WorkflowRunErrorCode.LoopAlreadyActive,
    ],
    [
      new RepoNotInProjectPoolError("p-1", ["acme/other"]),
      WorkflowRunErrorCode.RepositoryNotAllowed,
    ],
  ])("maps %s to a run error", async (error, code) => {
    mocks.createLoop.mockRejectedValue(error);

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("rethrows unexpected create errors", async () => {
    mocks.createLoop.mockRejectedValue(new Error("db down"));

    await expect(launchWorkflowLoop(baseInput)).rejects.toThrow("db down");
  });

  it("maps a failed dispatch", async () => {
    mocks.dispatchAndClassify.mockResolvedValue({
      ok: false,
      error: "launch_failed",
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.DispatchFailed },
    });
    expect(mocks.recordRunLoop).toHaveBeenCalled();
  });

  it("fails when the plan document is gone", async () => {
    mocks.findWithRegenerationContext.mockResolvedValue(null);

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.PlanStateUnavailable },
    });
  });
});

describe("launchWorkflowLoop — PLAN on a project with runners", () => {
  it("runs on the runner the project picks, preferring the workflow's computer", async () => {
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: "resolved",
      computeTargetId: PARENT_TARGET_ID,
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: true,
      value: { computeTargetId: PARENT_TARGET_ID },
    });
    expect(mocks.chooseProjectRunner).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      documentId: "plan-1",
      preferredComputeTargetId: TARGET_ID,
    });
    expect(mocks.resolveComputeTargetWithPreferences).not.toHaveBeenCalled();
  });

  it("fails when none of the project's runners is online", async () => {
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: "unavailable",
      message: "None of the project's runners is online",
    });

    const result = await launchWorkflowLoop(baseInput);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: WorkflowRunErrorCode.ComputeTargetUnavailable,
        message: "None of the project's runners is online",
      },
    });
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });

  it("uses the workflow's computer on a project without runners", async () => {
    await launchWorkflowLoop(baseInput);

    expect(mocks.resolveComputeTargetWithPreferences).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      TARGET_ID
    );
  });
});

describe("launchWorkflowLoop — EXECUTE", () => {
  const executeInput = { ...baseInput, command: LoopCommand.Execute };

  it("runs on the compute target of the state-bearing PLAN loop", async () => {
    mocks.findParent.mockResolvedValue({
      id: "plan-loop",
      computeTargetId: PARENT_TARGET_ID,
    });

    const result = await launchWorkflowLoop(executeInput);

    expect(result).toMatchObject({
      ok: true,
      value: { computeTargetId: PARENT_TARGET_ID },
    });
    expect(mocks.resolveComputeTargetWithPreferences).not.toHaveBeenCalled();
    expect(mocks.resolveLoopContext.mock.calls[0][1]).toEqual({
      command: RunLoopCommand.Execute,
      repo: { fullName: "acme/app", branch: "develop" },
    });
    expect(mocks.createLoop.mock.calls[0][2]).toMatchObject({
      command: LoopCommand.Execute,
      computeTargetId: PARENT_TARGET_ID,
    });
  });

  it("moves to another online project runner when the PLAN's is not available", async () => {
    mocks.findParent.mockResolvedValue({
      id: "plan-loop",
      computeTargetId: PARENT_TARGET_ID,
    });
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: ProjectRunnerChoiceKind.Resolved,
      computeTargetId: TARGET_ID,
    });

    const result = await launchWorkflowLoop(executeInput);

    expect(result).toMatchObject({
      ok: true,
      value: { computeTargetId: TARGET_ID },
    });
    expect(mocks.chooseProjectRunner).toHaveBeenCalledWith(
      expect.objectContaining({ preferredComputeTargetId: PARENT_TARGET_ID })
    );
  });

  it("stays on the PLAN's target when no project runner is online", async () => {
    mocks.findParent.mockResolvedValue({
      id: "plan-loop",
      computeTargetId: PARENT_TARGET_ID,
    });
    mocks.chooseProjectRunner.mockResolvedValue({
      kind: ProjectRunnerChoiceKind.Unavailable,
      message: "none online",
    });

    const result = await launchWorkflowLoop(executeInput);

    expect(result).toMatchObject({
      ok: true,
      value: { computeTargetId: PARENT_TARGET_ID },
    });
  });

  it("fails without a state-bearing PLAN loop", async () => {
    mocks.findParent.mockResolvedValue(null);

    const result = await launchWorkflowLoop(executeInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: WorkflowRunErrorCode.PlanStateUnavailable },
    });
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });
});
