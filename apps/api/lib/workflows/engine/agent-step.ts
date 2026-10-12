import {
  LOOP_STEP_PATHS_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepConfig,
  LoopStepFile,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  type AgentProcessStep,
  nextProcessStep,
  ProcessQuestionsPolicy,
  type ProcessStep,
  ProcessStepFinish,
  ProcessStepType,
  type ProcessToolkit,
  type RunStepState,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { documentVersionService } from "@/app/documents/document-version-service";
import { readStepResult } from "@/lib/loops/loop-commands/step-handler";
import { renderTemplate } from "@/lib/workflows/template";
import { markIssueInReview } from "./documents";
import { runError } from "./errors";
import { launchStepLoop } from "./launch-step";
import { type RunProcess, readRunProcessSnapshot } from "./process";
import { readAgentConfig, readRunSource, toJsonObject } from "./run-data";
import {
  findLatestRunLoop,
  isLoopSettled,
  listRunLoops,
  readRepoExecutionResults,
} from "./run-loops";
import { recordRunRepositoryBranches } from "./run-repository";
import { publishStepDocument } from "./step-documents";
import {
  type EngineRun,
  failRun,
  loopFailure,
  phaseTimedOut,
  type RunTransitionData,
  type StepOutcome,
  timeoutFailure,
  transition,
  WAIT,
} from "./step-outcome";
import { STEP_MAX_ATTEMPTS, stepRetryDelayMs } from "./step-retry";

/**
 * Agent steps of a project process (ProcessStepType.Agent, docs/workflows.md
 * "Project process"): the run is `running` while the step's STEP loop works
 * in the run's workspace. When the loop ends, the step either stops the run
 * with its questions (`needs_input`), ends it, or hands over to the next
 * step, which phases.ts enters.
 */

export type AgentStepStart = {
  run: EngineRun;
  agent: WorkflowAgentConfig;
  runProcess: RunProcess;
  step: AgentProcessStep;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
  /** The run's documents (the run row may not hold them yet while ingesting). */
  documents: { featureDocumentId: string; planDocumentId: string | null };
  /** Events of the transition into the step. */
  events: WorkflowRunEvent[];
  /** Columns of that transition (step id, snapshot, an earlier step's branch). */
  data: RunTransitionData | undefined;
};

/** What a finished agent step leads to. */
export type AgentStepSettlement =
  | { kind: "outcome"; outcome: StepOutcome }
  | {
      kind: "next";
      next: ProcessStep;
      agent: WorkflowAgentConfig;
      runProcess: RunProcess;
      /** Columns the transition into the next step also sets. */
      data: RunTransitionData;
    }
  | {
      /** The step's questions could not be read: resume it to rewrite them. */
      kind: "repairQuestions";
      step: AgentProcessStep;
      /** The loop that wrote them. */
      loopId: string;
      /** Why they could not be read. */
      error: string;
      /** Repair attempts including this one. */
      attempts: number;
      data: RunTransitionData;
    };

/** Times an asking step is resumed to rewrite questions that could not be read. */
export const QUESTIONS_REPAIR_MAX = 1;

/** Path of the Issue in the loop workspace ({{issue.file}}). */
export const STEP_ISSUE_FILE = `${LOOP_STEP_WORK_DIR}/${LoopStepFile.Issue}`;

/** Launches the step's STEP loop and moves the run into the step (`running`). */
export async function startAgentStep(
  input: AgentStepStart
): Promise<StepOutcome> {
  const { run, step, events } = input;
  const data: RunTransitionData = { ...input.data, stepState: null };
  // A retry after a crash between the launch and the status write: the loop
  // of this step already exists, so do not launch a second one.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    run.phaseStartedAt,
    step.id
  );
  if (launched) {
    return transition(WorkflowRunStatus.Running, events, data);
  }
  // The run's earlier loops hold its workspace: the step continues there.
  const earlierLoops = await listRunLoops(run.id);
  const launch = await launchStepLoop({
    runId: run.id,
    organizationId: run.organizationId,
    projectId: input.projectId,
    runAsUser: input.runAsUser,
    documentId:
      input.documents.planDocumentId ?? input.documents.featureDocumentId,
    agent: input.agent,
    step: toLoopStepConfig({
      runId: run.id,
      step,
      toolkit: input.runProcess.process.toolkit,
      fresh: earlierLoops.length === 0,
    }),
    prompt: await renderStepInstruction(
      run,
      step,
      input.documents.featureDocumentId
    ),
    computeTargetId: earlierLoops.at(-1)?.computeTargetId ?? null,
  });
  if (!launch.ok) {
    return failRun(launch.error, events);
  }
  return transition(WorkflowRunStatus.Running, events, data);
}

/**
 * running: wait for the step's loop, then stop for its questions, end the run
 * after the last step, or hand over to the next step. A TIMED_OUT loop that
 * its desktop can still revive is waited for.
 */
export async function settleAgentStep(
  run: EngineRun,
  now: Date
): Promise<AgentStepSettlement> {
  const agent = readAgentConfig(run.agentConfig);
  const snapshot = readRunProcessSnapshot(run.process);
  const step = snapshot
    ? snapshot.definition.steps.find(
        (candidate): candidate is AgentProcessStep =>
          candidate.id === run.stepId &&
          candidate.type === ProcessStepType.Agent
      )
    : undefined;
  if (!(agent && snapshot && step)) {
    return outcome(
      failRun(
        runError(
          WorkflowRunErrorCode.AgentConfigInvalid,
          "The run's process step could not be read."
        )
      )
    );
  }
  const loop = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    undefined,
    step.id
  );
  if (!loop) {
    return outcome(
      failRun(
        runError(
          WorkflowRunErrorCode.StepFailed,
          `No loop is linked to the "${step.name}" step.`
        )
      )
    );
  }
  if (!(await isLoopSettled(loop, now))) {
    return outcome(
      phaseTimedOut(run, now)
        ? timeoutFailure(`in the "${step.name}" step`)
        : WAIT
    );
  }
  if (loop.status !== LoopStatus.Completed) {
    return outcome(
      failRun(
        loopFailure(
          WorkflowRunErrorCode.StepFailed,
          `"${step.name}" step`,
          loop
        )
      )
    );
  }

  const data = await recordPushedBranches(run, step, loop);
  const result = readStepResult(loop.uploadedArtifacts);
  const published = await publishStepDocument({
    run,
    projectId: run.workflow.projectId,
    step,
    files: result?.files ?? [],
    variables: runIssueVariables(run),
  });
  if (!published.ok) {
    return outcome(retryPublish(run, published.error));
  }
  const asks = step.questions === ProcessQuestionsPolicy.Ask;
  if (asks && result?.questionsError) {
    const repair = readRunStepState(run.stepState)?.questionsRepair;
    const attempts = repair?.stepId === step.id ? repair.attempts : 0;
    if (attempts < QUESTIONS_REPAIR_MAX) {
      return {
        kind: "repairQuestions",
        step,
        loopId: loop.loopId,
        error: result.questionsError,
        attempts: attempts + 1,
        data,
      };
    }
    return outcome(
      failRun(
        runError(
          WorkflowRunErrorCode.StepFailed,
          `The "${step.name}" step wrote questions that could not be read, also after it was asked to rewrite them: ${result.questionsError}`
        )
      )
    );
  }
  const questions = result?.questions ?? [];
  if (asks && questions.length > 0) {
    const state: RunStepState = {
      waiting: {
        stepId: step.id,
        loopId: loop.loopId,
        questions,
        askedAt: now.toISOString(),
        answers: null,
        answeredBy: null,
      },
      approval: null,
    };
    return outcome(
      transition(WorkflowRunStatus.NeedsInput, [WorkflowRunEvent.NeedsInput], {
        ...data,
        stepState: toJsonObject(state),
      })
    );
  }
  const next = nextProcessStep(snapshot.definition, step.id);
  if (!next) {
    return outcome(
      transition(WorkflowRunStatus.Succeeded, [WorkflowRunEvent.Succeeded], {
        ...data,
        error: null,
      })
    );
  }
  return {
    kind: "next",
    next,
    agent,
    runProcess: { process: snapshot.definition, snapshot: true },
    data,
  };
}

/** True while the run waits for the answers to an agent step's questions. */
export function isWaitingOnAgentStep(run: Pick<EngineRun, "stepState">) {
  return readRunStepState(run.stepState)?.waiting != null;
}

export function readRunStepState(value: unknown): RunStepState | null {
  const parsed = runStepStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function outcome(value: StepOutcome): AgentStepSettlement {
  return { kind: "outcome", outcome: value };
}

/**
 * A pushing step sets the branch each repository was pushed to (for the
 * pull request actions) and the run's branch, and moves the Issue to review.
 */
async function recordPushedBranches(
  run: EngineRun,
  step: AgentProcessStep,
  loop: { branchName: string | null; uploadedArtifacts: unknown }
): Promise<RunTransitionData> {
  if (step.finish !== ProcessStepFinish.Push) {
    return {};
  }
  await recordRunRepositoryBranches(
    run.id,
    run.organizationId,
    readRepoExecutionResults(loop.uploadedArtifacts)
  );
  if (run.featureDocumentId) {
    await markIssueInReview(run.featureDocumentId, run.organizationId);
  }
  return loop.branchName ? { branchName: loop.branchName } : {};
}

export function toLoopStepConfig(input: {
  runId: string;
  step: AgentProcessStep;
  toolkit: ProcessToolkit | null;
  fresh: boolean;
}): LoopStepConfig {
  const { step, toolkit } = input;
  return {
    runId: input.runId,
    stepId: step.id,
    name: step.name,
    fresh: input.fresh,
    askQuestions: step.questions === ProcessQuestionsPolicy.Ask,
    // The reply and document files are collected like artifacts (first, so
    // they always fit).
    artifacts: [
      ...new Set(
        [step.reply, step.document?.path, ...step.artifacts].filter(
          (path): path is string => Boolean(path)
        )
      ),
    ].slice(0, LOOP_STEP_PATHS_MAX),
    finish: step.finish,
    toolkit: toolkit
      ? {
          repository: toolkit.repository,
          mounts: toolkit.mounts,
          instructions: toolkit.instructions,
        }
      : null,
  };
}

/** The step's instruction with the run's variables (PROCESS_INSTRUCTION_VARIABLES). */
async function renderStepInstruction(
  run: EngineRun,
  step: AgentProcessStep,
  featureDocumentId: string
): Promise<string> {
  const issue = await documentVersionService.getLatest(featureDocumentId);
  return renderTemplate(step.instruction, {
    ...runIssueVariables(run),
    "issue.body": issue?.content ?? "",
    "issue.file": STEP_ISSUE_FILE,
  });
}

/** {{issue.key}}, {{issue.title}} and {{issue.url}} of the run's source item. */
function runIssueVariables(run: Pick<EngineRun, "source">) {
  const source = readRunSource(run.source);
  const item = source?.inlineItem ?? source?.item ?? null;
  return {
    "issue.key": item?.key ?? "",
    "issue.title": item?.title ?? "",
    "issue.url": item?.url ?? "",
  };
}

/** Publishing again after a backoff, or a failed run once every attempt is used. */
function retryPublish(run: EngineRun, error: WorkflowRunError): StepOutcome {
  const delayMs = stepRetryDelayMs(run.stepAttempts + 1);
  if (delayMs === null) {
    return failRun({
      ...error,
      message: `${error.message} (gave up after ${STEP_MAX_ATTEMPTS} attempts)`,
    });
  }
  return { kind: "retry", delayMs, error };
}
