import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  nextProcessStep,
  ProcessQuestionsPolicy,
  type ProcessStep,
  ProcessStepType,
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
import { loopsService } from "@/app/loops/service";
import {
  createProviderContext,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import {
  RetryableSourceError,
  type SourceItem,
} from "@/lib/integrations/types";
import { hasEnabledPreActions } from "./actions";
import {
  readRunStepState,
  settleAgentStep,
  startAgentStep,
} from "./agent-step";
import {
  answersPrompt,
  repairStepQuestions,
  resumeAgentStep,
  ticketAnswersPrompt,
} from "./agent-step-resume";
import {
  ApprovalSettlementKind,
  enterApprovalStep,
  settleApproval,
} from "./approval-step";
import {
  approvePlanDocument,
  ensureRunDocuments,
  markIssueInReview,
} from "./documents";
import { runError, scrubProviderError } from "./errors";
import { launchWorkflowLoop } from "./launch";
import { PreActionsOutcomeKind, runPreActions } from "./pre-actions";
import {
  findStep,
  type RunProcess,
  readRunProcessSnapshot,
  resolveIngestProcess,
  resolveRunProcess,
  stepAgentPolicy,
  stepTransitionData,
  unsupportedStepError,
} from "./process";
import { readAgentConfig, readRunSource } from "./run-data";
import {
  findAdoptableLoop,
  findLatestRunLoop,
  isLoopSettled,
  type RunLoopState,
  readOpenQuestions,
  readRepoExecutionResults,
  recordRunLoop,
} from "./run-loops";
import { recordRunRepositoryBranches } from "./run-repository";
import {
  type EngineRun,
  failRun,
  loopFailure,
  phaseTimedOut,
  type RunTransitionData,
  type StepContext,
  type StepOutcome,
  timeoutFailure,
  transition,
  WAIT,
} from "./step-outcome";
import { STEP_MAX_ATTEMPTS, stepRetryDelayMs } from "./step-retry";

/**
 * One step of the run state machine per status (docs/workflows.md "Run state
 * machine"). A step never writes the run status itself: it returns the
 * transition, and advance.ts applies it under the lease together with the
 * events it enqueues.
 */

const LOG_PREFIX = "[workflows/engine]";

export async function runPhaseStep(
  run: EngineRun,
  context: StepContext
): Promise<StepOutcome> {
  const now = context.now;
  switch (run.status) {
    case WorkflowRunStatus.Received:
      return await stepReceived(run);
    case WorkflowRunStatus.PreActions:
      return await stepPreActions(run, context);
    case WorkflowRunStatus.Ingesting:
      return await stepIngesting(run);
    case WorkflowRunStatus.Planning:
      return await stepPlanning(run, now);
    case WorkflowRunStatus.Executing:
      return await stepExecuting(run, now);
    case WorkflowRunStatus.Running:
      return await stepRunning(run, now);
    case WorkflowRunStatus.NeedsInput:
      return await stepNeedsInput(run);
    case WorkflowRunStatus.NeedsApproval:
      return await stepNeedsApproval(run, now);
    default:
      return WAIT;
  }
}

type RunContext = {
  agent: WorkflowAgentConfig;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
};

/** Why the source item is unavailable; retryable for temporary failures. */
type SourceItemFailure = { error: WorkflowRunError; retryable: boolean };

/**
 * received: run the workflow's pre actions first (their run.triggered rows are
 * enqueued with the status write), else go straight to the agent team. A
 * disabled workflow writes nothing anywhere: ingesting fails the run.
 */
async function stepReceived(run: EngineRun): Promise<StepOutcome> {
  if (run.workflow.enabled && (await hasEnabledPreActions(run))) {
    return transition(WorkflowRunStatus.PreActions, [
      WorkflowRunEvent.Triggered,
    ]);
  }
  return transition(WorkflowRunStatus.Ingesting);
}

/** pre_actions: execute the cycle's pre action runs in order (pre-actions.ts). */
async function stepPreActions(
  run: EngineRun,
  context: StepContext
): Promise<StepOutcome> {
  // Disabled while waiting (e.g. for a retry): stop before writing anything.
  if (!run.workflow.enabled) {
    return failRun(workflowDisabledError());
  }
  const outcome = await runPreActions({
    run: { id: run.id, cycle: run.cycle },
    now: context.now,
    renewLease: context.renewLease,
  });
  switch (outcome.kind) {
    case PreActionsOutcomeKind.Done:
      return transition(WorkflowRunStatus.Ingesting);
    case PreActionsOutcomeKind.Failed:
      return failRun(outcome.error);
    default:
      return WAIT;
  }
}

/**
 * ingesting: validate, fetch the item, create documents, start the first
 * step of the run's process (PLAN on the built-in flow). A temporary source
 * failure (RetryableSourceError) is retried with backoff.
 */
async function stepIngesting(run: EngineRun): Promise<StepOutcome> {
  const context = await loadRunContext(run);
  if (!context.ok) {
    return failRun(context.error);
  }
  const item = await resolveSourceItem(run);
  if (!item.ok) {
    return item.error.retryable
      ? retrySourceFetch(run, item.error.error)
      : failRun(item.error.error);
  }
  const process = await resolveIngestProcess({
    organizationId: run.organizationId,
    projectId: context.value.projectId,
    stored: run.process,
    agent: context.value.agent,
  });
  if (!process.ok) {
    return failRun(process.error);
  }
  const [firstStep] = process.value.process.steps;
  if (!firstStep) {
    return failRun(agentConfigError());
  }
  const documents = await ensureRunDocuments({
    run,
    workflowName: run.workflow.name,
    projectId: context.value.projectId,
    runAsUserId: context.value.runAsUser.id,
    agent: context.value.agent,
    item: item.value,
    withPlanDocument: process.value.process.steps.some(
      (step) => step.type === ProcessStepType.AgentFlowPlan
    ),
  });
  if (!documents.ok) {
    return failRun(documents.error);
  }
  const firstStepData = stepTransitionData(
    process.value,
    firstStep.id,
    process.value.newSnapshot
  );
  const startedEvents =
    run.cycle === 1 ? [WorkflowRunEvent.Started] : ([] as WorkflowRunEvent[]);
  // The item triggered the run again while a process step waited for answers:
  // its comments answer that step, which goes on instead of starting over.
  const waiting = process.value.snapshot
    ? readRunStepState(run.stepState)?.waiting
    : null;
  if (waiting) {
    return await resumeAgentStep({
      run: { ...run, ...documents.value },
      agent: context.value.agent,
      projectId: context.value.projectId,
      runAsUser: context.value.runAsUser,
      waiting,
      prompt: ticketAnswersPrompt(waiting, item.value),
      events: startedEvents,
    });
  }
  if (firstStep.type === ProcessStepType.Agent) {
    return await startAgentStep({
      run,
      agent: context.value.agent,
      runProcess: process.value,
      step: firstStep,
      projectId: context.value.projectId,
      runAsUser: context.value.runAsUser,
      documents: documents.value,
      events: startedEvents,
      data: firstStepData,
    });
  }
  const planDocumentId = documents.value.planDocumentId;
  if (!(firstStep.type === ProcessStepType.AgentFlowPlan && planDocumentId)) {
    return failRun(unsupportedStepError(firstStep));
  }
  const planStepData = firstStepData;

  // A retry after a crash between launch and status write: the PLAN loop of
  // this phase already exists, so do not launch a second one.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Plan,
    run.phaseStartedAt
  );
  if (launched) {
    return transition(WorkflowRunStatus.Planning, startedEvents, planStepData);
  }
  const launch = await launchWorkflowLoop({
    runId: run.id,
    organizationId: run.organizationId,
    runAsUser: context.value.runAsUser,
    planDocumentId,
    command: LoopCommand.Plan,
    agent: context.value.agent,
    agentPolicy: stepAgentPolicy(firstStep),
  });
  if (!launch.ok) {
    return failRun(launch.error);
  }
  return transition(WorkflowRunStatus.Planning, startedEvents, planStepData);
}

/**
 * planning: wait for the PLAN loop, then finish, ask for input, or EXECUTE.
 * A TIMED_OUT loop that its desktop can still revive is waited for.
 */
async function stepPlanning(run: EngineRun, now: Date): Promise<StepOutcome> {
  const loop = await findLatestRunLoop(run.id, LoopCommand.Plan);
  if (!loop) {
    return failRun(
      runError(
        WorkflowRunErrorCode.PlanFailed,
        "No PLAN loop is linked to the run."
      )
    );
  }
  if (!(await isLoopSettled(loop, now))) {
    return phaseTimedOut(run, now) ? timeoutFailure("planning") : WAIT;
  }
  if (loop.status !== LoopStatus.Completed) {
    return failRun(loopFailure(WorkflowRunErrorCode.PlanFailed, "PLAN", loop));
  }

  const agent = readAgentConfig(run.agentConfig);
  if (!agent) {
    return failRun(agentConfigError(), [WorkflowRunEvent.PlanReady]);
  }
  const runProcess = resolveRunProcess(run.process, agent);
  const planStep = findStep(
    runProcess.process,
    ProcessStepType.AgentFlowPlan,
    run.stepId
  );
  const next = planStep
    ? nextProcessStep(runProcess.process, planStep.id)
    : null;
  // The plan is the last step (plan mode): it is the result, open questions
  // included.
  if (!next) {
    return transition(
      WorkflowRunStatus.Succeeded,
      [WorkflowRunEvent.PlanReady, WorkflowRunEvent.Succeeded],
      { error: null }
    );
  }
  const openQuestions = readOpenQuestions(loop.uploadedArtifacts);
  if (
    openQuestions.length > 0 &&
    planStep?.questions === ProcessQuestionsPolicy.Ask
  ) {
    return transition(WorkflowRunStatus.NeedsInput, [
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.NeedsInput,
    ]);
  }
  if (next.type === ProcessStepType.AgentFlowExecute) {
    return await startExecution(
      run,
      agent,
      stepTransitionData(runProcess, next.id)
    );
  }
  return await enterStep({
    run,
    agent,
    runProcess,
    step: next,
    events: [WorkflowRunEvent.PlanReady],
    now,
  });
}

/**
 * executing: wait for the EXECUTE loop, then record the branch each
 * repository was pushed to (and a PR the agent opened itself) and succeed. A
 * TIMED_OUT loop that its desktop can still revive is waited for.
 */
async function stepExecuting(run: EngineRun, now: Date): Promise<StepOutcome> {
  const loop = await findLatestRunLoop(run.id, LoopCommand.Execute);
  if (!loop) {
    return failRun(
      runError(
        WorkflowRunErrorCode.ExecuteFailed,
        "No EXECUTE loop is linked to the run."
      )
    );
  }
  if (!(await isLoopSettled(loop, now))) {
    return phaseTimedOut(run, now) ? timeoutFailure("executing") : WAIT;
  }
  if (loop.status !== LoopStatus.Completed) {
    return failRun(
      loopFailure(WorkflowRunErrorCode.ExecuteFailed, "EXECUTE", loop)
    );
  }
  await recordRunRepositoryBranches(
    run.id,
    run.organizationId,
    readRepoExecutionResults(loop.uploadedArtifacts)
  );
  const pullRequest = await resolvePullRequest(run.organizationId, loop);
  if (run.featureDocumentId) {
    await markIssueInReview(run.featureDocumentId, run.organizationId);
  }
  const next = stepAfterExecute(run);
  if (next) {
    return await enterStepAfterExecute(run, next, pullRequest, now);
  }
  return transition(WorkflowRunStatus.Succeeded, [WorkflowRunEvent.Succeeded], {
    error: null,
    prUrl: pullRequest.url,
    branchName: pullRequest.branch,
  });
}

/** running: an agent step of the process (agent-step.ts), then the next step. */
async function stepRunning(run: EngineRun, now: Date): Promise<StepOutcome> {
  const settled = await settleAgentStep(run, now);
  if (settled.kind === "outcome") {
    return settled.outcome;
  }
  if (settled.kind === "repairQuestions") {
    const context = await loadRunContext(run);
    if (!context.ok) {
      return failRun(context.error);
    }
    return await repairStepQuestions({
      run,
      agent: context.value.agent,
      projectId: context.value.projectId,
      runAsUser: context.value.runAsUser,
      step: settled.step,
      loopId: settled.loopId,
      error: settled.error,
      attempts: settled.attempts,
      data: settled.data,
    });
  }
  return await enterStep({
    run,
    agent: settled.agent,
    runProcess: settled.runProcess,
    step: settled.next,
    events: [],
    data: settled.data,
    now,
  });
}

/** needs_approval: the next step once approved, a failed run once rejected. */
async function stepNeedsApproval(
  run: EngineRun,
  now: Date
): Promise<StepOutcome> {
  const settled = settleApproval(run);
  switch (settled.kind) {
    case ApprovalSettlementKind.Rejected:
      return failRun(settled.error);
    case ApprovalSettlementKind.Approved: {
      if (!settled.next) {
        return transition(
          WorkflowRunStatus.Succeeded,
          [WorkflowRunEvent.Succeeded],
          { error: null, stepState: null }
        );
      }
      const agent = readAgentConfig(run.agentConfig);
      if (!agent) {
        return failRun(agentConfigError());
      }
      return await enterStep({
        run,
        agent,
        runProcess: resolveRunProcess(run.process, agent),
        step: settled.next,
        events: [],
        data: { stepState: null, cycle: nextWaitCycle(run) },
        now,
      });
    }
    default:
      return WAIT;
  }
}

/**
 * A person answered or approved a waiting process step in AgentFlow: the run
 * goes on in a new cycle, so the post actions of its next wait
 * (`run.needs_input`, once per cycle) fire again, as when a person adopts a
 * plan or the source item re-triggers the run.
 */
function nextWaitCycle(run: EngineRun): number {
  return run.cycle + 1;
}

/**
 * needs_input: a process step waiting for answers goes on once they are
 * given in AgentFlow. Otherwise adopt a PLAN/EXECUTE loop someone started
 * on the plan.
 */
async function stepNeedsInput(run: EngineRun): Promise<StepOutcome> {
  const waiting = readRunStepState(run.stepState)?.waiting;
  if (waiting) {
    return waiting.answers ? await answerWaitingStep(run, waiting) : WAIT;
  }
  if (!run.planDocumentId) {
    return WAIT;
  }
  const adoptable = await findAdoptableLoop({
    organizationId: run.organizationId,
    planDocumentId: run.planDocumentId,
    since: run.phaseStartedAt,
  });
  if (!adoptable) {
    return WAIT;
  }
  await recordRunLoop({
    organizationId: run.organizationId,
    runId: run.id,
    loopId: adoptable.id,
    command: adoptable.command,
    adopted: true,
  });
  const snapshot = readRunProcessSnapshot(run.process);
  if (adoptable.command === LoopCommand.Execute) {
    const execute = snapshot
      ? findStep(snapshot.definition, ProcessStepType.AgentFlowExecute, null)
      : null;
    return transition(
      WorkflowRunStatus.Executing,
      [],
      execute ? { stepId: execute.id } : undefined
    );
  }
  const plan = snapshot
    ? findStep(snapshot.definition, ProcessStepType.AgentFlowPlan, null)
    : null;
  // A new plan: a new cycle, so plan_ready / needs_input post actions fire
  // again. Pre actions only run when the source item triggers again.
  return transition(WorkflowRunStatus.Planning, [], {
    cycle: run.cycle + 1,
    ...(plan ? { stepId: plan.id } : {}),
  });
}

async function answerWaitingStep(
  run: EngineRun,
  waiting: NonNullable<
    NonNullable<ReturnType<typeof readRunStepState>>["waiting"]
  >
): Promise<StepOutcome> {
  const context = await loadRunContext(run);
  if (!context.ok) {
    return failRun(context.error);
  }
  return await resumeAgentStep({
    run,
    agent: context.value.agent,
    projectId: context.value.projectId,
    runAsUser: context.value.runAsUser,
    waiting,
    prompt: answersPrompt(waiting, waiting.answers ?? []),
    events: [],
    cycle: nextWaitCycle(run),
  });
}

async function startExecution(
  run: EngineRun,
  agent: WorkflowAgentConfig,
  stepData: RunTransitionData | undefined,
  planReady: WorkflowRunEvent[] = [WorkflowRunEvent.PlanReady]
): Promise<StepOutcome> {
  // Retry after a crash between the EXECUTE launch and the status write.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Execute,
    run.phaseStartedAt
  );
  if (launched) {
    return transition(WorkflowRunStatus.Executing, planReady, stepData);
  }
  if (!run.planDocumentId) {
    return failRun(
      runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        "The run has no implementation plan document."
      ),
      planReady
    );
  }
  const runAsUser = await findRunAsUser(run);
  if (!runAsUser) {
    return failRun(runAsUserError(), planReady);
  }
  const approved = await tryApprovePlan(run.planDocumentId, run.organizationId);
  if (!approved.ok) {
    return failRun(approved.error, planReady);
  }
  const launch = await launchWorkflowLoop({
    runId: run.id,
    organizationId: run.organizationId,
    runAsUser,
    planDocumentId: run.planDocumentId,
    command: LoopCommand.Execute,
    agent,
    agentPolicy: runStepAgentPolicy(
      run,
      agent,
      ProcessStepType.AgentFlowExecute,
      stepData?.stepId
    ),
  });
  if (!launch.ok) {
    return failRun(launch.error, planReady);
  }
  return transition(WorkflowRunStatus.Executing, planReady, stepData);
}

/** Steps after the implement step keep its pull request and branch on the run. */
async function enterStepAfterExecute(
  run: EngineRun,
  next: ProcessStep,
  pullRequest: { url: string | null; branch: string | null },
  now: Date
): Promise<StepOutcome> {
  const agent = readAgentConfig(run.agentConfig);
  if (!agent) {
    return failRun(agentConfigError());
  }
  return await enterStep({
    run,
    agent,
    runProcess: resolveRunProcess(run.process, agent),
    step: next,
    events: [],
    data: { prUrl: pullRequest.url, branchName: pullRequest.branch },
    now,
  });
}

/**
 * Moves a process run into `step` after the step that just finished: its
 * loop is launched and the run takes the step's status.
 */
async function enterStep(input: {
  run: EngineRun;
  agent: WorkflowAgentConfig;
  runProcess: RunProcess;
  step: ProcessStep;
  /** Events of the transition into the step. */
  events: WorkflowRunEvent[];
  /** Columns the transition also sets (the finished step's results). */
  data?: RunTransitionData;
  now: Date;
}): Promise<StepOutcome> {
  const { run, agent, step, events } = input;
  const data: RunTransitionData = {
    ...input.data,
    ...stepTransitionData(input.runProcess, step.id),
  };
  switch (step.type) {
    case ProcessStepType.AgentFlowExecute:
      return await startExecution(run, agent, data, events);
    case ProcessStepType.AgentFlowPlan:
      return await startPlanning(run, agent, data, events);
    case ProcessStepType.Agent:
      return await enterAgentStep({ ...input, step }, data);
    case ProcessStepType.Approval:
      return enterApprovalStep({ step, events, data, now: input.now });
    default:
      return failRun(unsupportedStepError(step), events);
  }
}

async function enterAgentStep(
  input: {
    run: EngineRun;
    agent: WorkflowAgentConfig;
    runProcess: RunProcess;
    step: Extract<ProcessStep, { type: typeof ProcessStepType.Agent }>;
    events: WorkflowRunEvent[];
  },
  data: RunTransitionData
): Promise<StepOutcome> {
  const { run, events } = input;
  const runAsUser = await findRunAsUser(run);
  if (!runAsUser) {
    return failRun(runAsUserError(), events);
  }
  const projectId = run.workflow.projectId;
  if (!(projectId && run.featureDocumentId)) {
    return failRun(
      runError(
        WorkflowRunErrorCode.ProjectMissing,
        "The run has no project or Issue document to run the step on."
      ),
      events
    );
  }
  return await startAgentStep({
    run,
    agent: input.agent,
    runProcess: input.runProcess,
    step: input.step,
    projectId,
    runAsUser,
    documents: {
      featureDocumentId: run.featureDocumentId,
      planDocumentId: run.planDocumentId,
    },
    events,
    data,
  });
}

/** A AgentFlow plan step after other steps: launch PLAN on the run's plan. */
async function startPlanning(
  run: EngineRun,
  agent: WorkflowAgentConfig,
  stepData: RunTransitionData,
  events: WorkflowRunEvent[]
): Promise<StepOutcome> {
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Plan,
    run.phaseStartedAt
  );
  if (launched) {
    return transition(WorkflowRunStatus.Planning, events, stepData);
  }
  if (!run.planDocumentId) {
    return failRun(
      runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        "The run has no implementation plan document."
      ),
      events
    );
  }
  const runAsUser = await findRunAsUser(run);
  if (!runAsUser) {
    return failRun(runAsUserError(), events);
  }
  const launch = await launchWorkflowLoop({
    runId: run.id,
    organizationId: run.organizationId,
    runAsUser,
    planDocumentId: run.planDocumentId,
    command: LoopCommand.Plan,
    agent,
    agentPolicy: runStepAgentPolicy(
      run,
      agent,
      ProcessStepType.AgentFlowPlan,
      stepData.stepId
    ),
  });
  if (!launch.ok) {
    return failRun(launch.error, events);
  }
  return transition(WorkflowRunStatus.Planning, events, stepData);
}

/** The step after the implement step of a process run; none on the built-in flow. */
function stepAfterExecute(run: EngineRun) {
  const snapshot = readRunProcessSnapshot(run.process);
  if (!snapshot) {
    return null;
  }
  const execute = findStep(
    snapshot.definition,
    ProcessStepType.AgentFlowExecute,
    run.stepId
  );
  return execute ? nextProcessStep(snapshot.definition, execute.id) : null;
}

async function loadRunContext(
  run: EngineRun
): Promise<Result<RunContext, WorkflowRunError>> {
  if (!run.workflow.enabled) {
    return Result.err(workflowDisabledError());
  }
  const projectId = run.workflow.projectId;
  const project = projectId
    ? await withDb((db) =>
        db.project.findFirst({
          where: { id: projectId, organizationId: run.organizationId },
          select: { id: true },
        })
      )
    : null;
  if (!project) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.ProjectMissing,
        "The workflow's project no longer exists. Choose a project on the workflow."
      )
    );
  }
  const runAsUser = await findRunAsUser(run);
  if (!runAsUser) {
    return Result.err(runAsUserError());
  }
  const agent = readAgentConfig(run.agentConfig);
  if (!agent) {
    return Result.err(agentConfigError());
  }
  return Result.ok({ agent, projectId: project.id, runAsUser });
}

/**
 * The inline item, else the canonical item fetched with the connection. A
 * RetryableSourceError (rate limited, 5xx, timeout) is reported as retryable.
 */
async function resolveSourceItem(
  run: EngineRun
): Promise<Result<SourceItem, SourceItemFailure>> {
  const source = readRunSource(run.source);
  if (!source) {
    return sourceError("The run's source item could not be read.");
  }
  if (source.inlineItem) {
    return Result.ok(source.inlineItem);
  }
  const loaded = run.connectionId
    ? await loadConnectionRuntime(run.organizationId, run.connectionId)
    : null;
  if (!loaded) {
    return sourceError(
      "The integration connection of the trigger is no longer available."
    );
  }
  const fetchItem = loaded.provider.source?.fetchItem;
  if (!fetchItem) {
    return sourceError(
      `${loaded.provider.displayName} cannot fetch source items.`
    );
  }
  try {
    const item = await fetchItem(
      createProviderContext(loaded.runtime, LOG_PREFIX),
      source.item
    );
    return Result.ok(item);
  } catch (error) {
    return sourceError(
      `Could not load ${source.item.key} from ${loaded.provider.displayName}: ${scrubProviderError(error, loaded.runtime.secrets)}`,
      error instanceof RetryableSourceError
    );
  }
}

/** Retry the import after its backoff, or fail once every attempt is used. */
function retrySourceFetch(
  run: EngineRun,
  error: WorkflowRunError
): StepOutcome {
  const failedAttempts = run.stepAttempts + 1;
  const delayMs = stepRetryDelayMs(failedAttempts);
  if (delayMs === null) {
    return failRun(
      runError(
        WorkflowRunErrorCode.SourceFetchFailed,
        `${error.message} (gave up after ${STEP_MAX_ATTEMPTS} attempts)`
      )
    );
  }
  return { kind: "retry", delayMs, error };
}

/** PR URL and branch from the loop row, else from its linked pull request. */
async function resolvePullRequest(
  organizationId: string,
  loop: RunLoopState
): Promise<{ url: string | null; branch: string | null }> {
  if (loop.prUrl) {
    return { url: loop.prUrl, branch: loop.branchName };
  }
  const detail = await loopsService.findById(loop.loopId, organizationId);
  const pullRequest = detail?.primaryPullRequest ?? null;
  return {
    url: pullRequest?.htmlUrl ?? null,
    branch:
      loop.branchName ??
      pullRequest?.headBranch ??
      detail?.primaryBranch?.branchName ??
      null,
  };
}

async function findRunAsUser(
  run: EngineRun
): Promise<{ id: string; clerkId: string } | null> {
  const runAsUserId = run.runAsUserId;
  if (!runAsUserId) {
    return null;
  }
  return await withDb((db) =>
    db.user.findFirst({
      where: {
        id: runAsUserId,
        organizationId: run.organizationId,
        active: true,
      },
      select: { id: true, clerkId: true },
    })
  );
}

/** The plan document must still exist to be approved and executed. */
async function tryApprovePlan(
  planDocumentId: string,
  organizationId: string
): Promise<Result<null, WorkflowRunError>> {
  try {
    await approvePlanDocument(planDocumentId, organizationId);
    return Result.ok(null);
  } catch (error) {
    return Result.err(
      runError(
        WorkflowRunErrorCode.PlanStateUnavailable,
        `The implementation plan could not be approved: ${parseError(error)}`
      )
    );
  }
}

function workflowDisabledError(): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.WorkflowDisabled,
    "The workflow is disabled."
  );
}

function runAsUserError(): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.RunAsUserMissing,
    "The workflow's run-as user is no longer an active member of the organization."
  );
}

function agentConfigError(): WorkflowRunError {
  return runError(
    WorkflowRunErrorCode.AgentConfigInvalid,
    "The workflow's agent settings are invalid. Save the workflow again."
  );
}

function sourceError(
  message: string,
  retryable = false
): Result<never, SourceItemFailure> {
  return Result.err({
    error: runError(WorkflowRunErrorCode.SourceFetchFailed, message),
    retryable,
  });
}

/** The agent policy of the run's plan or implement step about to launch. */
function runStepAgentPolicy(
  run: EngineRun,
  agent: WorkflowAgentConfig,
  type:
    | typeof ProcessStepType.AgentFlowPlan
    | typeof ProcessStepType.AgentFlowExecute,
  stepId: string | undefined
) {
  const { process } = resolveRunProcess(run.process, agent);
  return stepAgentPolicy(findStep(process, type, stepId ?? run.stepId));
}
