import {
  type LoopStepConfig,
  LoopStepFinish,
} from "@agentflow-ai/loops-api/loop-step";
import {
  LoopCommand,
  LoopStatus,
  MAX_ADDITIONAL_REPOS,
} from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";
import { integrationToolSessionService } from "@/app/integration-tools/integration-tool-session-service";
import { loopsService } from "@/app/loops/service";
import {
  findRepositoryCheckout,
  type LoopRepositorySelection,
  listProjectRepositoryCheckouts,
  toLoopRepositorySelection,
} from "@/app/projects/project-repository-checkouts";
import { resolveLaunchHarness } from "@/lib/loops/launch-harness";
import { LOOP_STEP_METADATA_KEY } from "@/lib/loops/loop-commands/step-handler";
import { dispatchAndClassify } from "@/lib/loops/loop-dispatch-utils";
import {
  forkUnsupportedMessage,
  runnerForksSession,
} from "@/lib/runner-fork-session";
import { runError } from "./errors";
import {
  cancelBlockedLoop,
  checkCommandSigning,
  dispatchError,
  mapLoopCreateError,
  resolveProjectComputeTarget,
} from "./launch";
import { personalRunnerBusy } from "./personal-runner-queue";
import { recordRunLoop } from "./run-loops";
import { recordRunRepositories } from "./run-repository";

/**
 * Launches the STEP loop of one agent step of a run's process: the
 * equivalent of launch.ts for process steps (docs/workflows.md "Project
 * process"). Every expected failure comes back as a run error.
 *
 * - A step works in the project repositories (integration connections); the
 *   GitHub App team pool is not used.
 * - The run's steps share one workspace on one computer: the first loop of a
 *   run picks the computer like PLAN does, every later loop runs where the
 *   run's earlier loops ran.
 * - The workflow_run_loops row (with the step id) is written before the
 *   dispatch, so the run owns the loop even when the dispatch fails.
 */

export type LaunchStepLoopInput = {
  runId: string;
  organizationId: string;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
  /** The run's plan document when it has one, else its Issue. */
  documentId: string;
  /**
   * The run's PRD or Issue. When the loop works on the plan, it is sent with
   * it, so the step reads the item it works on as well as the plan.
   */
  sourceDocumentId?: string | null;
  agent: WorkflowAgentConfig;
  /** The step settings the computer runs (loop metadata, sent with the loop). */
  step: LoopStepConfig;
  /** The rendered instruction (or the answers when resuming). */
  prompt: string;
  /** Computer of the run's earlier loops; null for the run's first loop. */
  computeTargetId: string | null;
  /** The loop whose agent session this one continues (answers to its questions). */
  resumeLoopId?: string;
};

export async function launchStepLoop(
  input: LaunchStepLoopInput
): Promise<
  Result<{ loopId: string; computeTargetId: string }, WorkflowRunError>
> {
  const repositories = await resolveStepRepositories(input);
  if (!repositories.ok) {
    return repositories;
  }

  const target: Result<string, WorkflowRunError> = input.computeTargetId
    ? Result.ok(input.computeTargetId)
    : await resolveProjectComputeTarget({
        organizationId: input.organizationId,
        userId: input.runAsUser.id,
        documentId: input.documentId,
        computeTargetId: input.agent.computeTargetId,
      });
  if (!target.ok) {
    return target;
  }
  const computeTargetId = target.value;
  // An old runner would resume the parent session in place: refuse before
  // the busy check, so it fails instead of queueing.
  const forkRefusal = await forkRefusalFor(input, computeTargetId);
  if (forkRefusal) {
    return Result.err(forkRefusal);
  }
  // A personal runner that runs one task at a time takes the runs in turn.
  const busy = await personalRunnerBusy({
    organizationId: input.organizationId,
    computeTargetId,
  });
  if (busy) {
    return Result.err(busy);
  }

  const signing = await checkCommandSigning(computeTargetId, input.runAsUser);
  if (!signing.ok) {
    return signing;
  }

  const harness = await resolveLaunchHarness(
    computeTargetId,
    input.organizationId,
    { clerkUserId: input.runAsUser.clerkId, userId: input.runAsUser.id }
  );

  let response: Awaited<ReturnType<typeof loopsService.create>>;
  try {
    response = await loopsService.create(
      input.organizationId,
      input.runAsUser.id,
      {
        command: LoopCommand.Step,
        harness,
        documentId: input.documentId,
        parentLoopId: input.resumeLoopId,
        computeTargetId,
        prompt: input.prompt,
        repo: repositories.value.primary,
        additionalRepos: repositories.value.additional,
        contextRefs: sourceContextRefs(input),
        metadata: {
          workflowRunId: input.runId,
          [LOOP_STEP_METADATA_KEY]: input.step,
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
        "The run's document is blocked by another document that is not finished yet, so the step was not started."
      )
    );
  }
  const loopId = response.loopId;
  // Another run took the runner at the same moment: the earlier loop wins.
  const raced = await personalRunnerBusy({
    organizationId: input.organizationId,
    computeTargetId,
    ownLoopId: loopId,
  });
  if (raced) {
    await cancelBlockedLoop(loopId, input.organizationId);
    return Result.err(raced);
  }

  await recordRunLoop({
    organizationId: input.organizationId,
    runId: input.runId,
    loopId,
    command: LoopCommand.Step,
    adopted: false,
    stepId: input.step.stepId,
  });
  // Repository actions ("Create pull request") work on the repositories a
  // pushing step records on the run; the first one records them, so a later
  // step never clears the branches an earlier one pushed.
  if (await shouldRecordRepositories(input)) {
    await recordRunRepositories({
      runId: input.runId,
      organizationId: input.organizationId,
      repos: [repositories.value.primary, ...repositories.value.additional].map(
        (repo) => ({ fullName: repo.fullName, baseBranch: repo.branch })
      ),
    });
  }

  // Before the dispatch: the runner asks for the session's token as soon as
  // the loop starts.
  if (input.step.integrationTools) {
    await integrationToolSessionService.openForStep({
      organizationId: input.organizationId,
      runId: input.runId,
      loopId,
      stepId: input.step.stepId,
      computeTargetId,
      expiresAt: new Date(Date.now() + STEP_TOOL_SESSION_MS),
    });
  }

  const dispatch = await dispatchAndClassify(
    loopId,
    input.organizationId,
    "workflow-engine",
    { workflowRunId: input.runId, documentId: input.documentId }
  );
  if (!dispatch.ok) {
    return Result.err(dispatchError(dispatch.error));
  }
  return Result.ok({ loopId, computeTargetId });
}

/**
 * Longest a step's tool session lasts: past the longest step timeout; the
 * session ends with its loop anyway.
 */
const STEP_TOOL_SESSION_MS = 25 * 60 * 60_000;

/**
 * The project repositories the step works in: the workflow's repository (or
 * the project's primary) first, then every other one. The toolkit must be
 * one of them, so its worktree is in the workspace to load it from.
 */
async function resolveStepRepositories(
  input: LaunchStepLoopInput
): Promise<Result<LoopRepositorySelection, WorkflowRunError>> {
  const checkouts = await listProjectRepositoryCheckouts(
    input.organizationId,
    input.projectId
  );
  const selection = toLoopRepositorySelection(
    checkouts,
    input.agent.repository?.fullName
  );
  if (!selection) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.NoRepository,
        "The project has no repositories. Add the project's repositories from an integration connection to run its process."
      )
    );
  }
  const toolkit = input.step.toolkit;
  if (toolkit && !findRepositoryCheckout(checkouts, toolkit.repository)) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        `The process toolkit repository ${toolkit.repository} is not one of the project's repositories.`
      )
    );
  }
  return Result.ok({
    primary: selection.primary,
    additional: selection.additional.slice(0, MAX_ADDITIONAL_REPOS),
  });
}

async function shouldRecordRepositories(
  input: LaunchStepLoopInput
): Promise<boolean> {
  if (input.step.finish !== LoopStepFinish.Push) {
    return false;
  }
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
      select: { repository: true },
    })
  );
  return run !== null && run.repository === null;
}

/** The run's PRD or Issue next to the plan the loop works on; none when they are the same. */
function sourceContextRefs(
  input: Pick<LaunchStepLoopInput, "documentId" | "sourceDocumentId">
): Array<{ sourceId: string; include: "full" }> | undefined {
  const sourceId = input.sourceDocumentId;
  return sourceId && sourceId !== input.documentId
    ? [{ sourceId, include: "full" }]
    : undefined;
}

/** The run error for a forked step on a runner that cannot fork, or null. */
async function forkRefusalFor(
  input: LaunchStepLoopInput,
  computeTargetId: string
): Promise<WorkflowRunError | null> {
  if (!input.step.forkSession) {
    return null;
  }
  const found = await computeTargetsService.findById(computeTargetId);
  const target = found?.organizationId === input.organizationId ? found : null;
  if (runnerForksSession(target?.capabilities)) {
    return null;
  }
  return runError(
    WorkflowRunErrorCode.ComputeTargetUnavailable,
    forkUnsupportedMessage({
      machineName: target?.machineName,
      session: "the failed step's session",
      advice:
        "Update the runner, or retry the step with Restart (a new session).",
    })
  );
}
