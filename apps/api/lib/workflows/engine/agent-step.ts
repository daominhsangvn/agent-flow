import {
  LOOP_STEP_PATHS_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepCollectedFile,
  type LoopStepConfig,
  LoopStepFile,
} from "@agentflow-ai/loops-api/loop-step";
import { normalizeConnectionGrants } from "@repo/api/src/types/connection-grants";
import {
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
} from "@repo/api/src/types/loop";
import {
  type AgentProcessStep,
  agentStepFinish,
  nextProcessStep,
  ProcessQuestionsPolicy,
  type ProcessStep,
  ProcessStepFinish,
  ProcessStepRole,
  ProcessStepType,
  type ProcessToolkit,
  type ProjectProcess,
  type RunStepState,
  runStepStateSchema,
  writesReleaseNotes,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { documentVersionService } from "@/app/documents/document-version-service";
import { readStepResult } from "@/lib/loops/loop-commands/step-handler";
import { renderTemplate } from "@/lib/workflows/template";
import { approvePlanDocument, markIssueInReview } from "./documents";
import { RUNNER_WITHOUT_TOOLS, runError } from "./errors";
import { launchStepLoop } from "./launch-step";
import { stepLaunchFailure } from "./personal-runner-queue";
import { type RunProcess, readRunProcessSnapshot } from "./process";
import { enterReview } from "./review-step";
import { readAgentConfig, readRunSource, toJsonObject } from "./run-data";
import {
  findLatestRunLoop,
  isLoopSettled,
  listRunLoops,
  type RunLoopState,
  readRepoExecutionResults,
} from "./run-loops";
import { recordRunRepositoryBranches } from "./run-repository";
import {
  publishReleaseNotes,
  publishRunPlanVersion,
  publishStepDocument,
  STEP_RELEASE_NOTES_FILE,
} from "./step-documents";
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
import {
  STEP_MAX_ATTEMPTS,
  STEP_RETRY_BACKOFF_MS,
  stepRetryDelayMs,
} from "./step-retry";

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
      /** Events of the transition (execute.completed after a pushing step). */
      events: WorkflowRunEvent[];
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
    }
  | {
      /**
       * The step's agent failed on the model provider and the backoff of an
       * automatic retry (AgentProcessStep.retry) elapsed: its session goes on
       * in a fork.
       */
      kind: "autoRetry";
      step: AgentProcessStep;
      /** The failed loop. */
      loop: RunLoopState;
      /** Automatic retries including this one. */
      attempts: number;
    }
  | {
      /** A plan step ended without its plan: resume it to write the plan. */
      kind: "repairOutput";
      step: AgentProcessStep;
      /** The loop that did not write it. */
      loopId: string;
      /** Repair attempts including this one. */
      attempts: number;
      data: RunTransitionData;
    };

/** Times an asking step is resumed to rewrite questions that could not be read. */
export const QUESTIONS_REPAIR_MAX = 1;

/** Times a plan step is resumed to write the plan it did not write. */
export const OUTPUT_REPAIR_MAX = 1;

/** Path of the Issue in the loop workspace ({{issue.file}}). */
export const STEP_ISSUE_FILE = `${LOOP_STEP_WORK_DIR}/${LoopStepFile.Issue}`;

/** Where a plan step writes the run's plan, and an implement step reads the approved one. */
export const STEP_PLAN_FILE = `${LOOP_STEP_WORK_DIR}/${LoopStepFile.Plan}`;

/** Launches the step's STEP loop and moves the run into the step (`running`). */
export async function startAgentStep(
  input: AgentStepStart
): Promise<StepOutcome> {
  const { run, step, events } = input;
  const data: RunTransitionData = { ...input.data, stepState: null };
  const started = [...events, ...stepStartedEvents(step)];
  // An implement step works from the approved plan, as EXECUTE does.
  if (step.role === ProcessStepRole.Implement) {
    const approved = await approveRunPlan(
      input.documents.planDocumentId,
      run.organizationId
    );
    if (approved) {
      return failRun(approved, events);
    }
  }
  // A retry after a crash between the launch and the status write: the loop
  // of this step already exists, so do not launch a second one.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    run.phaseStartedAt,
    step.id
  );
  if (launched) {
    return transition(WorkflowRunStatus.Running, started, data);
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
    sourceDocumentId: input.documents.featureDocumentId,
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
    return stepLaunchFailure(launch.error, events);
  }
  return transition(WorkflowRunStatus.Running, started, data);
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
    return outcome(failRun(stepUnreadableError()));
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
  const loopError = await settledLoopError(step, loop);
  if (loopError) {
    return autoRetryOrFail(run, step, loop, loopError);
  }

  return await settleStepOutputs({
    run,
    step,
    loop,
    agent,
    process: snapshot.definition,
    now,
  });
}

/** A step whose loop completed: its documents, questions, then the next step. */
async function settleStepOutputs(input: {
  run: EngineRun;
  step: AgentProcessStep;
  loop: RunLoopState;
  agent: WorkflowAgentConfig;
  process: ProjectProcess;
  now: Date;
}): Promise<AgentStepSettlement> {
  const { run, step, loop } = input;
  const data = await recordPushedBranches(run, step, loop);
  const executed = pushingStepEvents(step, WorkflowRunEvent.ExecuteCompleted);
  const result = readStepResult(loop.uploadedArtifacts);
  const published = await publishStepOutputs(run, step, result?.files ?? []);
  if (!published.ok) {
    return outcome(retryPublish(run, published.error));
  }
  const asks = step.questions === ProcessQuestionsPolicy.Ask;
  if (asks && result?.questionsError) {
    return unreadableQuestions(
      run,
      step,
      loop.loopId,
      result.questionsError,
      data
    );
  }
  const questions = result?.questions ?? [];
  const asking = asks && questions.length > 0;
  if (step.role === ProcessStepRole.Plan && !published.value && !asking) {
    return missingPlan(run, step, loop.loopId, data);
  }
  if (asking) {
    const state: RunStepState = {
      waiting: {
        stepId: step.id,
        loopId: loop.loopId,
        questions,
        askedAt: input.now.toISOString(),
        answers: null,
        answeredBy: null,
      },
      approval: null,
    };
    return outcome(
      transition(
        WorkflowRunStatus.NeedsInput,
        [...executed, WorkflowRunEvent.NeedsInput],
        { ...data, stepState: toJsonObject(state) }
      )
    );
  }
  const finished = [...stepFinishedEvents(step), ...executed];
  if (step.review) {
    return outcome(
      enterReview({
        run,
        step,
        loopId: loop.loopId,
        data,
        events: finished,
        now: input.now,
      })
    );
  }
  const next = nextProcessStep(input.process, step.id);
  if (!next) {
    return outcome(
      transition(
        WorkflowRunStatus.Succeeded,
        [...finished, WorkflowRunEvent.Succeeded],
        { ...data, error: null }
      )
    );
  }
  return {
    kind: "next",
    next,
    agent: input.agent,
    runProcess: { process: input.process, snapshot: true },
    data,
    events: finished,
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
  if (agentStepFinish(step) !== ProcessStepFinish.Push) {
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

/**
 * A pushing step is the run's implementation, like EXECUTE: it reports
 * execute.started / execute.completed (`event`); other steps report nothing.
 */
function pushingStepEvents(
  step: AgentProcessStep,
  event: WorkflowRunEvent
): WorkflowRunEvent[] {
  return agentStepFinish(step) === ProcessStepFinish.Push ? [event] : [];
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
    // The role's files, the reply and the document are collected like
    // artifacts (first, so they always fit).
    artifacts: [
      ...new Set(
        [
          ...roleOutputFiles(step),
          step.reply,
          step.document?.path,
          ...step.artifacts,
        ].filter((path): path is string => Boolean(path))
      ),
    ].slice(0, LOOP_STEP_PATHS_MAX),
    finish: agentStepFinish(step),
    // The step's grant gives its agent integration tools.
    ...(normalizeConnectionGrants(step.connections).length > 0
      ? { integrationTools: true }
      : {}),
    toolkit: toolkit
      ? {
          repository: toolkit.repository,
          mounts: toolkit.mounts,
          instructions: toolkit.instructions,
        }
      : null,
    ...(step.role ? { role: step.role } : {}),
    ...(writesReleaseNotes(step) ? { releaseNotes: true } : {}),
  };
}

/** The step's instruction with the run's variables (PROCESS_INSTRUCTION_VARIABLES). */
export async function renderStepInstruction(
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
export function runIssueVariables(run: Pick<EngineRun, "source">) {
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

/**
 * Why the step's settled loop fails the run: it did not complete, or its
 * step had integration tools its runner never opened (an older runner), so
 * its agent could not act. Null when the loop completed as it should.
 */
async function settledLoopError(
  step: AgentProcessStep,
  loop: RunLoopState
): Promise<WorkflowRunError | null> {
  if (loop.status !== LoopStatus.Completed) {
    return loopFailure(
      WorkflowRunErrorCode.StepFailed,
      `"${step.name}" step`,
      loop
    );
  }
  return (await stepToolsNeverOpened(loop.loopId))
    ? runError(
        WorkflowRunErrorCode.StepFailed,
        `"${step.name}" step: ${RUNNER_WITHOUT_TOOLS}`
      )
    : null;
}

/**
 * True when the step's loop had integration tools but its runner never asked
 * for them (a runner from before integration tools).
 */
async function stepToolsNeverOpened(loopId: string): Promise<boolean> {
  const session = await withDb((db) =>
    db.integrationToolSession.findUnique({
      where: { loopId },
      select: { issuedAt: true },
    })
  );
  return session !== null && session.issuedAt === null;
}

/** Files a step's role writes, collected before any other. */
function roleOutputFiles(step: AgentProcessStep): string[] {
  if (step.role === ProcessStepRole.Plan) {
    return [STEP_PLAN_FILE];
  }
  return writesReleaseNotes(step) ? [STEP_RELEASE_NOTES_FILE] : [];
}

/**
 * A plan step's plan as a new version of the run's plan document. Ok(true)
 * when the step wrote one, Ok(false) when it did not (or has no plan role).
 */
async function publishPlanOutput(
  run: EngineRun,
  step: AgentProcessStep,
  files: readonly LoopStepCollectedFile[]
): Promise<Result<boolean, WorkflowRunError>> {
  if (step.role !== ProcessStepRole.Plan) {
    return Result.ok(false);
  }
  const file = files.find((candidate) => candidate.path === STEP_PLAN_FILE);
  if (!file?.content.trim()) {
    return Result.ok(false);
  }
  if (!(run.planDocumentId && run.runAsUserId)) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        `The "${step.name}" step wrote a plan, but the run has no implementation plan document to keep it in.`
      )
    );
  }
  const published = await publishRunPlanVersion({
    run: {
      id: run.id,
      organizationId: run.organizationId,
      planDocumentId: run.planDocumentId,
      runAsUserId: run.runAsUserId,
    },
    step,
    file,
  });
  return published.ok ? Result.ok(true) : published;
}

/**
 * A plan step ended without its plan and without questions: resume it once to
 * write the plan, then fail the step.
 */
function missingPlan(
  run: EngineRun,
  step: AgentProcessStep,
  loopId: string,
  data: RunTransitionData
): AgentStepSettlement {
  const repair = readRunStepState(run.stepState)?.outputRepair;
  const attempts = repair?.stepId === step.id ? repair.attempts : 0;
  if (attempts < OUTPUT_REPAIR_MAX) {
    return {
      kind: "repairOutput",
      step,
      loopId,
      attempts: attempts + 1,
      data,
    };
  }
  return outcome(
    failRun(
      runError(
        WorkflowRunErrorCode.StepFailed,
        `The "${step.name}" step did not write the plan to ${STEP_PLAN_FILE}, also after it was asked to.`
      )
    )
  );
}

/**
 * Approves the run's plan before an implement step works from it. Null when
 * approved, else why the run cannot go on.
 */
async function approveRunPlan(
  planDocumentId: string | null,
  organizationId: string
): Promise<WorkflowRunError | null> {
  if (!planDocumentId) {
    return runError(
      WorkflowRunErrorCode.PlanStateUnavailable,
      "The run has no implementation plan for the implement step to work from."
    );
  }
  try {
    await approvePlanDocument(planDocumentId, organizationId);
    return null;
  } catch (error) {
    return runError(
      WorkflowRunErrorCode.PlanStateUnavailable,
      `The implementation plan could not be approved: ${parseError(error)}`
    );
  }
}

/** Events of entering a step: plan.started for a plan step, execute.started for a pushing one. */
export function stepStartedEvents(step: AgentProcessStep): WorkflowRunEvent[] {
  return [
    ...(step.role === ProcessStepRole.Plan
      ? [WorkflowRunEvent.PlanStarted]
      : []),
    ...pushingStepEvents(step, WorkflowRunEvent.ExecuteStarted),
  ];
}

/** plan.completed once a plan step wrote the plan and goes on. */
function stepFinishedEvents(step: AgentProcessStep): WorkflowRunEvent[] {
  return step.role === ProcessStepRole.Plan ? [WorkflowRunEvent.PlanReady] : [];
}

function stepUnreadableError(): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.AgentConfigInvalid,
    "The run's process step could not be read."
  );
}

/**
 * The step's documents: its own document, a plan step's plan and an
 * implement step's release notes. Ok(true) when a plan step wrote its plan.
 */
async function publishStepOutputs(
  run: EngineRun,
  step: AgentProcessStep,
  files: readonly LoopStepCollectedFile[]
): Promise<Result<boolean, WorkflowRunError>> {
  const variables = runIssueVariables(run);
  const published = await publishStepDocument({
    run,
    projectId: run.projectId,
    step,
    files,
    variables,
  });
  if (!published.ok) {
    return published;
  }
  if (writesReleaseNotes(step)) {
    const notes = await publishReleaseNotes({
      run,
      projectId: run.projectId,
      step,
      files,
      variables,
    });
    if (!notes.ok) {
      return notes;
    }
  }
  return await publishPlanOutput(run, step, files);
}

/**
 * Questions that could not be read: resume the step to rewrite them
 * (QUESTIONS_REPAIR_MAX times), then fail it.
 */
function unreadableQuestions(
  run: EngineRun,
  step: AgentProcessStep,
  loopId: string,
  error: string,
  data: RunTransitionData
): AgentStepSettlement {
  const repair = readRunStepState(run.stepState)?.questionsRepair;
  const attempts = repair?.stepId === step.id ? repair.attempts : 0;
  if (attempts < QUESTIONS_REPAIR_MAX) {
    return {
      kind: "repairQuestions",
      step,
      loopId,
      error,
      attempts: attempts + 1,
      data,
    };
  }
  return outcome(
    failRun(
      runError(
        WorkflowRunErrorCode.StepFailed,
        `The "${step.name}" step wrote questions that could not be read, also after it was asked to rewrite them: ${error}`
      )
    )
  );
}

/**
 * Loop failures of the model provider (an expired token, a quota, an
 * overload, LoopErrorCode.AuthChallenge) that an automatic retry may outlast.
 */
const AUTO_RETRY_LOOP_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  LoopErrorCode.AuthChallenge,
]);

/**
 * A failed step loop fails the run, unless the step retries automatically
 * (AgentProcessStep.retry) after a model provider failure: the run keeps
 * running, waits the backoff (stepAttempts, nextStepAt), then the failed
 * session goes on in a fork, at most `retry.attempts` times.
 */
function autoRetryOrFail(
  run: EngineRun,
  step: AgentProcessStep,
  loop: RunLoopState,
  error: WorkflowRunError
): AgentStepSettlement {
  const allowed = step.retry?.attempts ?? 0;
  const retryable =
    allowed > 0 &&
    loop.sessionId !== null &&
    loop.error !== null &&
    AUTO_RETRY_LOOP_ERROR_CODES.has(loop.error.code);
  if (!retryable) {
    return outcome(failRun(error));
  }
  const state = readRunStepState(run.stepState)?.autoRetry;
  const used = state?.stepId === step.id ? state.attempts : 0;
  if (used >= allowed) {
    return outcome(
      failRun({
        ...error,
        message: `${error.message} (gave up after ${used} automatic retries)`,
      })
    );
  }
  if (run.stepAttempts === 0) {
    const delayMs =
      stepRetryDelayMs(used + 1) ?? STEP_RETRY_BACKOFF_MS.at(-1) ?? 0;
    return outcome({ kind: "retry", delayMs, error });
  }
  return { kind: "autoRetry", step, loop, attempts: used + 1 };
}
