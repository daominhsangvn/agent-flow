import { LoopCommand } from "@repo/api/src/types/loop";
import {
  type AgentProcessStep,
  type ProcessStep,
  ProcessStepRole,
  type ReviewDecision,
  ReviewSession,
  ReviewSignalVia,
  type RunStepState,
} from "@repo/api/src/types/project-process";
import type { Result } from "@repo/api/src/types/result";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { parseError } from "@repo/observability/error";
import {
  renderStepInstruction,
  runIssueVariables,
  stepStartedEvents,
  toLoopStepConfig,
} from "./agent-step";
import { approvePlanDocument } from "./documents";
import { runError } from "./errors";
import { launchStepLoop } from "./launch-step";
import { stepLaunchFailure } from "./personal-runner-queue";
import { readRunProcessSnapshot } from "./process";
import {
  approvedReviewState,
  feedbackPrompt,
  feedbackRoundState,
  ReviewSettlementKind,
  settleReview,
} from "./review-step";
import { readRunSource, toJsonObject } from "./run-data";
import { findLatestRunLoop, listRunLoops } from "./run-loops";
import { readFeedbackComments, removeSourceLabel } from "./source-connection";
import {
  type EngineRun,
  failRun,
  type RunTransitionData,
  type StepOutcome,
  transition,
  WAIT,
} from "./step-outcome";

/**
 * What a decided review leads to (docs/workflows.md "Review loops"; the
 * review itself is review-step.ts): the next step, a feedback round of the
 * same step, or a failed run. phases.ts hands in how it loads the run's
 * context and enters a step, which this module cannot import.
 */

type RunReview = NonNullable<RunStepState["review"]>;

export type ReviewRunContext = {
  agent: WorkflowAgentConfig;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
};

/** needs_approval on a reviewed step; null when the run waits on an approval step. */
export async function advanceReview(input: {
  run: EngineRun;
  loadContext: () => Promise<Result<ReviewRunContext, WorkflowRunError>>;
  /** Enters the step after the reviewed one, in a new cycle. */
  enterNext: (
    next: ProcessStep,
    data: RunTransitionData
  ) => Promise<StepOutcome>;
}): Promise<StepOutcome | null> {
  const { run } = input;
  const settled = settleReview(run);
  switch (settled.kind) {
    case ReviewSettlementKind.NotReview:
      return null;
    case ReviewSettlementKind.Waiting:
      return WAIT;
    case ReviewSettlementKind.Rejected:
      return failRun(settled.error);
    case ReviewSettlementKind.Approved:
      return await goOn(run, settled, input.enterNext);
    default: {
      const context = await input.loadContext();
      if (!context.ok) {
        return failRun(context.error);
      }
      return await startFeedbackRound({
        run,
        context: context.value,
        step: settled.step,
        review: settled.review,
        decision: settled.decision,
      });
    }
  }
}

/**
 * A feedback round: the reviewed step runs again with the feedback, on the
 * computer of its latest loop, continuing its session (`resume`) or in a new
 * one (`fresh`), in a new cycle so its events and the next wait notify again.
 * A feedback label is removed from the source item first (`consumeLabels`).
 */
export async function startFeedbackRound(input: {
  run: EngineRun;
  context: ReviewRunContext;
  step: AgentProcessStep;
  review: RunReview;
  decision: ReviewDecision;
}): Promise<StepOutcome> {
  const { run, step, review } = input;
  const events = stepStartedEvents(step);
  const decision = await withFeedbackText(run, review, input.decision);
  const data: RunTransitionData = {
    stepId: step.id,
    stepState: toJsonObject(feedbackRoundState(review, decision)),
    cycle: run.cycle + 1,
  };
  // A retry after a crash between the launch and the status write.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    run.phaseStartedAt,
    step.id
  );
  if (launched && launched.loopId !== review.loopId) {
    return transition(WorkflowRunStatus.Running, events, data);
  }
  const snapshot = readRunProcessSnapshot(run.process);
  const documentId = run.planDocumentId ?? run.featureDocumentId;
  if (!(snapshot && documentId && run.featureDocumentId)) {
    return failRun(
      runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        "The step under review could not be read, so the feedback cannot be passed on."
      )
    );
  }
  if (
    decision.via === ReviewSignalVia.Label &&
    decision.label &&
    step.review?.consumeLabels !== false
  ) {
    await removeSourceLabel(
      run,
      decision.label,
      `${run.id}:review:${review.round}`
    );
  }
  const prompt = feedbackPrompt({
    step,
    review,
    decision,
    variables: runIssueVariables(run),
  });
  const fresh = step.review?.session === ReviewSession.Fresh;
  const reviewed = (await listRunLoops(run.id)).find(
    (loop) => loop.loopId === review.loopId
  );
  const launch = await launchStepLoop({
    runId: run.id,
    organizationId: run.organizationId,
    projectId: input.context.projectId,
    runAsUser: input.context.runAsUser,
    documentId,
    sourceDocumentId: run.featureDocumentId,
    agent: input.context.agent,
    step: toLoopStepConfig({
      runId: run.id,
      step,
      toolkit: snapshot.definition.toolkit,
      fresh: false,
    }),
    prompt: fresh
      ? `${await renderStepInstruction(run, step, run.featureDocumentId)}\n\n${prompt}`
      : prompt,
    computeTargetId: reviewed?.computeTargetId ?? null,
    ...(fresh ? {} : { resumeLoopId: review.loopId }),
  });
  if (!launch.ok) {
    return stepLaunchFailure(launch.error);
  }
  return transition(WorkflowRunStatus.Running, events, data);
}

/**
 * An approved (or completed) review: a plan step's plan is approved, then
 * the next step starts, or the run succeeds after the last one.
 */
async function goOn(
  run: EngineRun,
  settled: {
    step: AgentProcessStep;
    next: ProcessStep | null;
    review: RunReview;
  },
  enterNext: (
    next: ProcessStep,
    data: RunTransitionData
  ) => Promise<StepOutcome>
): Promise<StepOutcome> {
  if (settled.step.role === ProcessStepRole.Plan && run.planDocumentId) {
    try {
      await approvePlanDocument(run.planDocumentId, run.organizationId);
    } catch (error) {
      return failRun(
        runError(
          WorkflowRunErrorCode.PlanStateUnavailable,
          `The implementation plan could not be approved: ${parseError(error)}`
        )
      );
    }
  }
  const state = approvedReviewState(settled.review);
  if (!settled.next) {
    return transition(
      WorkflowRunStatus.Succeeded,
      [WorkflowRunEvent.Succeeded],
      { error: null, stepState: state ? toJsonObject(state) : null }
    );
  }
  return await enterNext(settled.next, {});
}

/**
 * A feedback signalled on the source item (a label, a mention) gets the
 * comments written for it as its text; one given in AgentFlow keeps its own.
 */
async function withFeedbackText(
  run: EngineRun,
  review: RunReview,
  decision: ReviewDecision
): Promise<ReviewDecision> {
  if (decision.via === ReviewSignalVia.App || decision.text) {
    return decision;
  }
  const source = readRunSource(run.source);
  const text = await readFeedbackComments(run, source?.item ?? null, {
    after: review.history.at(-1)?.at ?? null,
    until: decision.at,
  });
  return { ...decision, text };
}
