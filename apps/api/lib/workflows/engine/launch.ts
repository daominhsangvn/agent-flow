import type { LoopAgentPolicy } from "@agentflow-ai/loops-api/context-pack";
import {
  LoopCommand,
  LoopStatus,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { computeTargetsService } from "@/app/compute-targets/service";
import { resolveLoopContext } from "@/app/documents/[id]/run-loop/run-loop-helpers";
import { documentGenerationService } from "@/app/documents/generation-service";
import {
  isConcurrentLoopLimitError,
  isLoopAlreadyActiveError,
  isRepoNotInProjectPoolError,
  isUnauthorizedRepoError,
} from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import {
  chooseProjectRunner,
  ProjectRunnerChoiceKind,
  type ProjectRunnerScope,
} from "@/app/projects/project-runner-selection";
import {
  CommandSigningRequirementStatus,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { jsonObjectSchema } from "@/lib/json-schema";
import {
  type ComputeTargetError,
  resolveComputeTargetWithPreferences,
} from "@/lib/loops/compute-target-resolver";
import { resolveLaunchHarness } from "@/lib/loops/launch-harness";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import {
  CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE,
  type DispatchErrorCode,
  dispatchAndClassify,
  LAUNCH_FAILED_DISPATCH_MESSAGE,
  MISSING_ANTHROPIC_API_KEY_MESSAGE,
  PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE,
} from "@/lib/loops/loop-dispatch-utils";
import { buildLoopPrompt } from "@/lib/loops/prompts";
import { runError } from "./errors";
import { isPersonalRunnerTarget } from "./personal-runner-queue";
import { type EngineLoopCommand, recordRunLoop } from "./run-loops";
import { recordRunRepositories } from "./run-repository";

/**
 * Programmatic PLAN / EXECUTE launcher: the equivalent of
 * POST /documents/{id}/run-loop without HTTP objects (docs/workflows.md
 * "Launching loops"). Every expected failure comes back as a run error.
 *
 * - PLAN runs on the workflow's compute target (owned by or shared with the
 *   run-as user, online).
 * - EXECUTE continues the PLAN's state, so it runs on the PLAN loop's target.
 * - A target that enforces browser command signing cannot be used: an
 *   unattended run has no browser to sign with.
 * - A BLOCKED loop is never dispatched (it is cancelled and reported).
 * - The workflow_run_loops row is written before the dispatch, so the run
 *   owns the loop even when the dispatch fails.
 * - EXECUTE records the project repositories it works in on the run, for
 *   repository actions such as "Create pull request".
 * - A process step that changes what its agents decide on their own
 *   (`agentPolicy`) keeps it in the loop's metadata; the loop carries it to
 *   the computer.
 */

export type LaunchWorkflowLoopInput = {
  runId: string;
  organizationId: string;
  runAsUser: { id: string; clerkId: string };
  planDocumentId: string;
  command: AgentFlowCommand;
  agent: WorkflowAgentConfig;
  /** From the plan or implement step (stepAgentPolicy); absent on the built-in flow. */
  agentPolicy?: LoopAgentPolicy;
};

/** The AgentFlow agent loops (STEP loops start in launch-step.ts). */
type AgentFlowCommand = Exclude<EngineLoopCommand, typeof LoopCommand.Step>;

export type LaunchedLoop = { loopId: string; computeTargetId: string };

export async function launchWorkflowLoop(
  input: LaunchWorkflowLoopInput
): Promise<Result<LaunchedLoop, WorkflowRunError>> {
  const artifact = await documentGenerationService.findWithRegenerationContext(
    input.planDocumentId,
    input.organizationId
  );
  if (!artifact) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        "The implementation plan document no longer exists."
      )
    );
  }

  const target = await resolveTarget(input);
  if (!target.ok) {
    return target;
  }
  const computeTargetId = target.value;

  const signing = await checkCommandSigning(computeTargetId, input.runAsUser);
  if (!signing.ok) {
    return signing;
  }

  const handler = getCommandHandler(input.command);
  const context = await resolveLoopContext(
    artifact,
    {
      command: toRunLoopCommand(input.command),
      repo: input.agent.repository ?? undefined,
    },
    handler,
    input.organizationId,
    input.runAsUser.id,
    input.planDocumentId,
    computeTargetId
  );
  if (handler?.requiresRepo && !context.targetRepo) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.NoRepository,
        "No repository configured. Link a repository to the project or set a repository override on the workflow."
      )
    );
  }

  const harness = await resolveLaunchHarness(
    computeTargetId,
    input.organizationId,
    { clerkUserId: input.runAsUser.clerkId, userId: input.runAsUser.id }
  );

  const created = await createLoop(input, {
    harness,
    computeTargetId,
    parentLoopId: context.parentLoopId,
    targetRepo: context.targetRepo,
    targetBranch: context.targetBranch,
    additionalRepos: context.additionalRepos,
    contextRefs: context.contextRefs,
  });
  if (!created.ok) {
    return created;
  }
  const loopId = created.value;

  await recordRunLoop({
    organizationId: input.organizationId,
    runId: input.runId,
    loopId,
    command: input.command,
    adopted: false,
  });
  if (input.command === LoopCommand.Execute) {
    await recordRunRepositories({
      runId: input.runId,
      organizationId: input.organizationId,
      repos: loopRepositories(context),
    });
  }

  const dispatch = await dispatchAndClassify(
    loopId,
    input.organizationId,
    "workflow-engine",
    { workflowRunId: input.runId, documentId: input.planDocumentId }
  );
  if (!dispatch.ok) {
    return Result.err(dispatchError(dispatch.error));
  }
  return Result.ok({ loopId, computeTargetId });
}

type LoopContextForCreate = {
  harness: Awaited<ReturnType<typeof resolveLaunchHarness>>;
  computeTargetId: string;
  parentLoopId: string | undefined;
  targetRepo: string | undefined;
  targetBranch: string;
  additionalRepos: Awaited<
    ReturnType<typeof resolveLoopContext>
  >["additionalRepos"];
  contextRefs: Awaited<ReturnType<typeof resolveLoopContext>>["contextRefs"];
};

/**
 * PLAN: one of the project's runners when it has some (the workflow's target
 * when it is one), else the workflow's target. EXECUTE: the target that ran
 * the PLAN while it is an online project runner, else another online project
 * runner (the runner restores the plan's saved state, docs/runner.md "Plan
 * state"), else the PLAN's target as before.
 */
async function resolveTarget(
  input: LaunchWorkflowLoopInput
): Promise<Result<string, WorkflowRunError>> {
  if (input.command === LoopCommand.Execute) {
    const parent = await loopsService.findLatestStateBearingDesktopForArtifact(
      input.planDocumentId,
      input.organizationId
    );
    if (!parent?.computeTargetId) {
      return Result.err(
        runError(
          WorkflowRunErrorCode.PlanStateUnavailable,
          "No completed PLAN run with desktop state was found for the plan, so the implementation cannot continue it."
        )
      );
    }
    const runner = await chooseProjectRunner({
      organizationId: input.organizationId,
      userId: input.runAsUser.id,
      documentId: input.planDocumentId,
      preferredComputeTargetId: parent.computeTargetId,
    });
    return Result.ok(
      runner.kind === ProjectRunnerChoiceKind.Resolved
        ? runner.computeTargetId
        : parent.computeTargetId
    );
  }

  return await resolveProjectComputeTarget({
    organizationId: input.organizationId,
    userId: input.runAsUser.id,
    documentId: input.planDocumentId,
    computeTargetId: input.agent.computeTargetId,
  });
}

/**
 * The computer a run's first loop starts on: one of the project's runners
 * when it has some (the workflow's computer when it is one of them), else the
 * workflow's computer. The project is the document's, or the given one
 * before the run has documents.
 */
export async function resolveProjectComputeTarget(
  input: {
    organizationId: string;
    userId: string;
    computeTargetId: string;
  } & ProjectRunnerScope
): Promise<Result<string, WorkflowRunError>> {
  // A project with runners runs on them; the workflow's computer is kept
  // when it is one of them, or when it is a personal runner.
  const personal = await isPersonalRunnerTarget(input);
  const runner = personal
    ? ({ kind: ProjectRunnerChoiceKind.None } as const)
    : await chooseProjectRunner({
        organizationId: input.organizationId,
        userId: input.userId,
        preferredComputeTargetId: input.computeTargetId,
        ...projectRunnerScope(input),
      });
  if (runner.kind === ProjectRunnerChoiceKind.Resolved) {
    return Result.ok(runner.computeTargetId);
  }
  if (runner.kind === ProjectRunnerChoiceKind.Unavailable) {
    return Result.err(
      runError(WorkflowRunErrorCode.ComputeTargetUnavailable, runner.message)
    );
  }

  const resolved = await resolveComputeTargetWithPreferences(
    input.organizationId,
    input.userId,
    input.computeTargetId
  );
  if (!resolved.ok) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.ComputeTargetUnavailable,
        computeTargetMessage(resolved.error)
      )
    );
  }
  if (!resolved.computeTargetId) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.ComputeTargetUnavailable,
        computeTargetMessage("compute_target_not_found")
      )
    );
  }
  return Result.ok(resolved.computeTargetId);
}

/**
 * Fails closed: a target that requires signed commands, or whose signing
 * eligibility cannot be verified, cannot run an unattended workflow loop.
 */
export async function checkCommandSigning(
  computeTargetId: string,
  runAsUser: { id: string; clerkId: string }
): Promise<Result<null, WorkflowRunError>> {
  const target = await computeTargetsService.findById(computeTargetId);
  const capabilities = jsonObjectSchema.safeParse(target?.capabilities);
  if (!(target?.userId && capabilities.success)) {
    return Result.ok(null);
  }
  const requirement = await resolveCommandSigningRequirement({
    capabilities: capabilities.data,
    organizationId: target.organizationId,
    targetUserId: target.userId,
    targetGatewayId: target.gatewayId,
    requesterUserId: runAsUser.id,
    requesterClerkUserId: runAsUser.clerkId,
    targetOwnerClerkUserId: target.user?.clerkId ?? null,
  });
  if (requirement.status === CommandSigningRequirementStatus.NotRequired) {
    return Result.ok(null);
  }
  const reason =
    requirement.status === CommandSigningRequirementStatus.Required
      ? "requires browser-signed commands"
      : "could not be checked for command signing";
  return Result.err(
    runError(
      WorkflowRunErrorCode.SigningRequired,
      `The compute target ${reason}, which unattended workflow runs cannot provide. Turn off command signing on the target or choose another target.`
    )
  );
}

async function createLoop(
  input: LaunchWorkflowLoopInput,
  context: LoopContextForCreate
): Promise<Result<string, WorkflowRunError>> {
  let response: Awaited<ReturnType<typeof loopsService.create>>;
  try {
    response = await loopsService.create(
      input.organizationId,
      input.runAsUser.id,
      {
        command: input.command,
        harness: context.harness,
        documentId: input.planDocumentId,
        parentLoopId: context.parentLoopId,
        computeTargetId: context.computeTargetId,
        prompt: buildLoopPrompt(
          input.command,
          undefined,
          context.additionalRepos
        ),
        repo: context.targetRepo
          ? { fullName: context.targetRepo, branch: context.targetBranch }
          : undefined,
        additionalRepos: context.additionalRepos,
        contextRefs:
          context.contextRefs.length > 0 ? context.contextRefs : undefined,
        metadata: {
          workflowRunId: input.runId,
          ...(input.agentPolicy ? { agentPolicy: input.agentPolicy } : {}),
        },
      }
    );
  } catch (error) {
    const mapped = mapLoopCreateError(error);
    if (mapped) {
      return Result.err(mapped);
    }
    throw error;
  }

  if (response.status === LoopStatus.Blocked) {
    await cancelBlockedLoop(response.loopId, input.organizationId);
    return Result.err(
      runError(
        WorkflowRunErrorCode.DocumentBlocked,
        "The plan document is blocked by another document that is not finished yet, so the loop was not started."
      )
    );
  }
  return Result.ok(response.loopId);
}

/** A BLOCKED loop is never dispatched by anyone; cancel it so it does not linger. */
export async function cancelBlockedLoop(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    await loopsService.cancel(loopId, organizationId);
  } catch (error) {
    log.warn("[workflows/launch] Could not cancel a blocked loop", {
      loopId,
      organizationId,
      error: parseError(error),
    });
  }
}

export function mapLoopCreateError(error: unknown): WorkflowRunError | null {
  if (isConcurrentLoopLimitError(error)) {
    return runError(WorkflowRunErrorCode.ConcurrencyLimit, error.message);
  }
  if (isLoopAlreadyActiveError(error)) {
    return runError(WorkflowRunErrorCode.LoopAlreadyActive, error.message);
  }
  if (isRepoNotInProjectPoolError(error) || isUnauthorizedRepoError(error)) {
    return runError(WorkflowRunErrorCode.RepositoryNotAllowed, error.message);
  }
  return null;
}

export function dispatchError(code: DispatchErrorCode): WorkflowRunError {
  switch (code) {
    case "parent_state_unavailable":
      return runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE
      );
    case "callback_unavailable":
      return runError(
        WorkflowRunErrorCode.DispatchFailed,
        CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE
      );
    case "missing_anthropic_api_key":
      return runError(
        WorkflowRunErrorCode.DispatchFailed,
        MISSING_ANTHROPIC_API_KEY_MESSAGE
      );
    default:
      return runError(
        WorkflowRunErrorCode.DispatchFailed,
        LAUNCH_FAILED_DISPATCH_MESSAGE
      );
  }
}

function computeTargetMessage(error: ComputeTargetError): string {
  switch (error) {
    case "compute_target_offline":
      return "The workflow's compute target is offline. Start the desktop app on that machine.";
    case "no_online_targets":
      return "No compute target is online for the run-as user.";
    case "multiple_targets":
      return "Several compute targets are online; set one on the workflow.";
    default:
      return "The workflow's compute target was not found, or the run-as user cannot use it.";
  }
}

function toRunLoopCommand(command: AgentFlowCommand) {
  return command === LoopCommand.Execute
    ? RunLoopCommand.Execute
    : RunLoopCommand.Plan;
}

/** The loop's repositories, its first one first, with their base branches. */
function loopRepositories(
  context: Pick<
    LoopContextForCreate,
    "targetRepo" | "targetBranch" | "additionalRepos"
  >
): Array<{ fullName: string; baseBranch: string }> {
  if (!context.targetRepo) {
    return [];
  }
  return [
    { fullName: context.targetRepo, baseBranch: context.targetBranch },
    ...(context.additionalRepos ?? []).map((repo) => ({
      fullName: repo.fullName,
      baseBranch: repo.branch,
    })),
  ];
}

/** Only the scope's own key: the project's id, or its document's. */
function projectRunnerScope(scope: ProjectRunnerScope): ProjectRunnerScope {
  return scope.projectId === undefined
    ? { documentId: scope.documentId }
    : { projectId: scope.projectId };
}
