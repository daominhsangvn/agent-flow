import {
  type AgentProcessStep,
  nextProcessStep,
  type ProcessStep,
  ProcessStepType,
  REVIEW_HISTORY_MAX,
  type ReviewDecision,
  ReviewDecisionKind,
  ReviewSignalVia,
  type RunStepState,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { renderTemplate, type TemplateVariables } from "../template";
import { runError } from "./errors";
import { readRunProcessSnapshot } from "./process";
import { toJsonObject } from "./run-data";
import {
  type EngineRun,
  type RunTransitionData,
  type StepOutcome,
  transition,
} from "./step-outcome";

/**
 * Review loops (docs/workflows.md "Review loops"): an agent step with
 * `review` stops the run after its work (`needs_approval`, input.needed)
 * until people decide, in AgentFlow or on the source item:
 *
 * - approve (a plan step) or complete (any other step): the run goes on with
 *   the next step, or succeeds after the last one;
 * - feedback: the same step runs again with it (a feedback round,
 *   agent-step-resume.ts startFeedbackRound), then waits again;
 * - reject (AgentFlow only): the run fails.
 *
 * Signals that arrived while the step still worked (`pendingSignals`) decide
 * the review as soon as it starts waiting.
 */

type RunReview = NonNullable<RunStepState["review"]>;

export const ReviewSettlementKind = {
  /** The run does not wait on a review (an approval step). */
  NotReview: "not_review",
  Waiting: "waiting",
  Approved: "approved",
  Feedback: "feedback",
  Rejected: "rejected",
} as const;

export type ReviewSettlement =
  | { kind: typeof ReviewSettlementKind.NotReview }
  | { kind: typeof ReviewSettlementKind.Waiting }
  | {
      kind: typeof ReviewSettlementKind.Approved;
      step: AgentProcessStep;
      /** null: the reviewed step was the last one. */
      next: ProcessStep | null;
      review: RunReview;
    }
  | {
      kind: typeof ReviewSettlementKind.Feedback;
      step: AgentProcessStep;
      review: RunReview;
      decision: ReviewDecision;
    }
  | { kind: typeof ReviewSettlementKind.Rejected; error: WorkflowRunError };

/**
 * The run waits for the review of `step`, whose latest loop is `loopId`.
 * A later round keeps the history of the earlier ones; a pending signal
 * decides it at once (and then nobody is notified of a wait).
 */
export function enterReview(input: {
  run: EngineRun;
  step: AgentProcessStep;
  loopId: string;
  /** Columns the settled step already set (pushed branches). */
  data: RunTransitionData;
  /** Events of the settled step (plan.completed, execute.completed). */
  events: WorkflowRunEvent[];
  now: Date;
}): StepOutcome {
  const state = readStepState(input.run.stepState);
  const previous =
    state?.review?.stepId === input.step.id ? state.review : null;
  const [pending, ...rest] = state?.pendingSignals ?? [];
  const review: RunReview = {
    stepId: input.step.id,
    loopId: input.loopId,
    round: previous ? previous.round + 1 : 1,
    requestedAt: input.now.toISOString(),
    decision: pending ?? null,
    history: previous?.history ?? [],
  };
  const next: RunStepState = {
    waiting: null,
    approval: null,
    review,
    ...(rest.length > 0 ? { pendingSignals: rest } : {}),
  };
  return transition(
    WorkflowRunStatus.NeedsApproval,
    pending ? input.events : [...input.events, WorkflowRunEvent.NeedsInput],
    { ...input.data, stepState: toJsonObject(next) }
  );
}

/** needs_approval on a reviewed step: what its recorded decision leads to. */
export function settleReview(run: EngineRun): ReviewSettlement {
  const review = readStepState(run.stepState)?.review;
  if (!review) {
    return { kind: ReviewSettlementKind.NotReview };
  }
  if (!review.decision) {
    return { kind: ReviewSettlementKind.Waiting };
  }
  const snapshot = readRunProcessSnapshot(run.process);
  const step = snapshot?.definition.steps.find(
    (candidate): candidate is AgentProcessStep =>
      candidate.id === review.stepId && candidate.type === ProcessStepType.Agent
  );
  if (!(snapshot && step)) {
    return {
      kind: ReviewSettlementKind.Rejected,
      error: runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        "The step under review could not be read."
      ),
    };
  }
  const { decision } = review;
  switch (decision.kind) {
    case ReviewDecisionKind.Approve:
      return {
        kind: ReviewSettlementKind.Approved,
        step,
        next: nextProcessStep(snapshot.definition, step.id),
        review,
      };
    case ReviewDecisionKind.Feedback:
      return {
        kind: ReviewSettlementKind.Feedback,
        step,
        review,
        decision,
      };
    default:
      return {
        kind: ReviewSettlementKind.Rejected,
        error: runError(
          WorkflowRunErrorCode.ReviewRejected,
          decision.text
            ? `The "${step.name}" step was rejected: ${decision.text}`
            : `The "${step.name}" step was rejected.`
        ),
      };
  }
}

/**
 * The step state while a feedback round runs: the review stays (so the
 * next wait is a later round) with the decision moved to its history.
 */
export function feedbackRoundState(
  review: RunReview,
  decision: ReviewDecision
): RunStepState {
  return {
    waiting: null,
    approval: null,
    review: {
      ...review,
      requestedAt: "",
      decision: null,
      history: [...review.history, decision].slice(-REVIEW_HISTORY_MAX),
    },
  };
}

/** The step state once an approved review goes on: the decision is kept in the history. */
export function approvedReviewState(review: RunReview): RunStepState | null {
  return review.decision
    ? {
        waiting: null,
        approval: null,
        review: {
          ...review,
          history: [...review.history, review.decision].slice(
            -REVIEW_HISTORY_MAX
          ),
        },
      }
    : null;
}

/**
 * What the agent of a feedback round is told: who asked for what and how,
 * then the step's `review.instruction` rendered with {{feedback.*}}.
 */
export function feedbackPrompt(input: {
  step: AgentProcessStep;
  review: RunReview;
  decision: ReviewDecision;
  variables: TemplateVariables;
}): string {
  const { decision } = input;
  const who = decision.author ?? (decision.by ? "A reviewer" : "Someone");
  const text = decision.text.trim();
  const lines = [
    `Review round ${input.review.round} of the "${input.step.name}" step: ${who} asked for changes ${viaPhrase(decision)}.`,
    "",
    text
      ? `Feedback:\n${text}`
      : "No feedback text was given; read the item's latest comments.",
  ];
  const instruction = input.step.review?.instruction?.trim();
  if (instruction) {
    lines.push(
      "",
      renderTemplate(instruction, {
        ...input.variables,
        "feedback.text": text,
        "feedback.author": who,
        "feedback.via": decision.via,
        "review.round": String(input.review.round),
      })
    );
  }
  lines.push(
    "",
    "Change your earlier work accordingly rather than starting over, then finish the step as before."
  );
  return lines.join("\n");
}

function viaPhrase(decision: ReviewDecision): string {
  switch (decision.via) {
    case ReviewSignalVia.Label:
      return `by adding the label "${decision.label ?? ""}" to the item`;
    case ReviewSignalVia.Mention:
      return "in a comment that mentions you on the item";
    default:
      return "in AgentFlow";
  }
}

function readStepState(value: unknown): RunStepState | null {
  const parsed = runStepStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
