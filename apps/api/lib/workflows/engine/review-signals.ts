import {
  approvalFromSignal,
  PENDING_SIGNALS_MAX,
  type ProcessStep,
  ProcessStepType,
  type ReviewDecision,
  ReviewDecisionKind,
  ReviewSignalVia,
  type RunStepState,
  reviewGoOnLabels,
  runProcessSnapshotSchema,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import type { InboundEvent, ReviewSignalFacts } from "@/lib/integrations/types";

/**
 * Signals from the source item to a run that waits on it (docs/workflows.md
 * "Review loops"): a label (tag) added, or a comment that mentions the bot,
 * decides the review of the run's step or its approval step, whatever the
 * workflow's triggers are, and never starts a run. A signal that arrives
 * while the step still works is queued (`pendingSignals`) until it waits.
 *
 * Only runs of the event's project connection and item are looked at, and a
 * run waiting for answers (`needs_input`) is left to the triggers, whose
 * mention answers its questions.
 */

const LOG_PREFIX = "[workflows/review-signals]";

/** Statuses a signal can reach: waiting for the review, or still working. */
const SIGNALLED_STATUSES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.NeedsApproval,
  WorkflowRunStatus.Running,
  WorkflowRunStatus.Planning,
  WorkflowRunStatus.Executing,
];

export type SignalledRun = { runId: string; workflowId: string };

/** Records the event's signal on the runs it reaches; the runs it reached. */
export async function routeReviewSignals(input: {
  connection: LoadedConnection;
  event: InboundEvent;
  projectConnectionId: string;
  sourceKey: string;
}): Promise<SignalledRun[]> {
  const facts = input.connection.provider.reviewSignal?.(input.event) ?? null;
  if (!(facts && (facts.addedLabels.length > 0 || facts.mentioned))) {
    return [];
  }
  const runs = await withDb((db) =>
    db.workflowRun.findMany({
      where: {
        organizationId: input.connection.record.organizationId,
        projectConnectionId: input.projectConnectionId,
        sourceKey: input.sourceKey,
        status: { in: [...SIGNALLED_STATUSES] },
      },
      select: {
        id: true,
        workflowId: true,
        status: true,
        stepId: true,
        process: true,
        stepState: true,
        occurrenceKeys: true,
      },
    })
  );
  const signalled: SignalledRun[] = [];
  for (const run of runs) {
    if (run.occurrenceKeys.includes(input.event.dedupKey)) {
      continue;
    }
    const signal = matchSignal(run, facts);
    if (!signal) {
      continue;
    }
    // A feedback's text is read from the item's comments when its round
    // starts (review-round.ts), so a queued one gets them too.
    const decision: ReviewDecision = {
      ...signal,
      text: "",
      by: null,
      author: input.event.actor?.displayName ?? null,
      at: input.event.occurredAt.toISOString(),
    };
    if (await recordSignal(run, decision, input.event.dedupKey)) {
      signalled.push({ runId: run.id, workflowId: run.workflowId });
    }
  }
  return signalled;
}

type SignalRun = {
  id: string;
  status: string;
  stepId: string | null;
  process: Prisma.JsonValue;
  stepState: Prisma.JsonValue;
};

type MatchedSignal = Pick<ReviewDecision, "kind" | "via" | "label">;

/**
 * The signal the facts give the run's step under review or approval (or the
 * one right after it while the run still works); null when they match none
 * or match both a go-on and a feedback label.
 */
function matchSignal(
  run: SignalRun,
  facts: ReviewSignalFacts
): MatchedSignal | null {
  const snapshot = runProcessSnapshotSchema.safeParse(run.process);
  const steps = snapshot.success ? snapshot.data.definition.steps : [];
  const index = steps.findIndex((step) => step.id === run.stepId);
  const current = steps[index];
  const candidates =
    run.status === WorkflowRunStatus.NeedsApproval
      ? [current]
      : [current, steps[index + 1]];
  for (const step of candidates) {
    const config = step ? signalConfig(step) : null;
    if (config) {
      return signalFor(config, facts);
    }
  }
  return null;
}

type SignalConfig = {
  goOn: string[];
  feedback: string[];
  mention: boolean;
};

function signalConfig(step: ProcessStep): SignalConfig | null {
  if (step.type === ProcessStepType.Agent && step.review) {
    return {
      goOn: reviewGoOnLabels(step.review),
      feedback: step.review.feedback.labels,
      mention: step.review.feedback.mention,
    };
  }
  if (step.type === ProcessStepType.Approval && step.approve) {
    return { goOn: step.approve.labels, feedback: [], mention: false };
  }
  return null;
}

function signalFor(
  config: SignalConfig,
  facts: ReviewSignalFacts
): MatchedSignal | null {
  const goOn = findLabel(config.goOn, facts.addedLabels);
  const feedback = findLabel(config.feedback, facts.addedLabels);
  if (goOn && feedback) {
    log.warn(`${LOG_PREFIX} An approve and a feedback label at once; ignored`, {
      goOn,
      feedback,
    });
    return null;
  }
  if (goOn) {
    return {
      kind: ReviewDecisionKind.Approve,
      via: ReviewSignalVia.Label,
      label: goOn,
    };
  }
  if (feedback) {
    return {
      kind: ReviewDecisionKind.Feedback,
      via: ReviewSignalVia.Label,
      label: feedback,
    };
  }
  return config.mention && facts.mentioned
    ? {
        kind: ReviewDecisionKind.Feedback,
        via: ReviewSignalVia.Mention,
        label: null,
      }
    : null;
}

/** The configured label among the added ones (case-insensitive), as configured. */
function findLabel(
  configured: readonly string[],
  added: readonly string[]
): string | null {
  const keys = new Set(added.map((label) => label.toLowerCase()));
  return configured.find((label) => keys.has(label.toLowerCase())) ?? null;
}

/**
 * Writes the signal on the run when it is still as read: the decision of
 * the waiting review or approval, else a pending signal. False when the run
 * moved on in the meantime or cannot take it (the review already decided).
 */
async function recordSignal(
  run: SignalRun & { occurrenceKeys: string[] },
  decision: ReviewDecision,
  dedupKey: string
): Promise<boolean> {
  const state = readStepState(run.stepState);
  const next = signalledState(run, state, decision);
  if (!next) {
    return false;
  }
  const updated = await withDb((db) =>
    db.workflowRun.updateMany({
      where: {
        id: run.id,
        status: run.status,
        stepId: run.stepId,
        ...(run.stepState === null
          ? { stepState: { equals: Prisma.DbNull } }
          : {
              stepState: {
                equals: run.stepState as Prisma.InputJsonValue,
              },
            }),
      },
      data: {
        stepState: next,
        occurrenceKeys: { push: dedupKey },
        nextStepAt: null,
      },
    })
  );
  return updated.count === 1;
}

function signalledState(
  run: SignalRun,
  state: RunStepState | null,
  decision: ReviewDecision
): RunStepState | null {
  if (run.status === WorkflowRunStatus.NeedsApproval) {
    if (state?.review && !state.review.decision) {
      return { ...state, review: { ...state.review, decision } };
    }
    if (
      state?.approval &&
      !state.approval.decision &&
      decision.kind === ReviewDecisionKind.Approve
    ) {
      return {
        ...state,
        approval: { ...state.approval, decision: approvalFromSignal(decision) },
      };
    }
    return null;
  }
  const pending = state?.pendingSignals ?? [];
  if (pending.length >= PENDING_SIGNALS_MAX) {
    return null;
  }
  return {
    waiting: state?.waiting ?? null,
    approval: state?.approval ?? null,
    ...(state ?? {}),
    pendingSignals: [...pending, decision],
  };
}

function readStepState(value: unknown): RunStepState | null {
  const parsed = runStepStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
