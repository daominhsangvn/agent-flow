import {
  LOOP_STEP_ARTIFACT_KEY,
  LoopStepResultSchema,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  type ProcessStep,
  ProcessStepRole,
  ProcessStepType,
  type RunProcessView,
  type RunStepState,
  reviewGoOnLabels,
  runProcessSnapshotSchema,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import { z } from "zod";
import type { RunLoopState } from "./run-loops";

/**
 * The process of a run as its detail page shows it: the steps of its
 * snapshot, where the run is, what it waits for, and the files each agent
 * step collected. Null for a run on the built-in flow. Reads the stored
 * columns with their schemas only, so the run queries do not load the engine.
 */
export function buildRunProcessView(
  run: { process: unknown; stepId: string | null; stepState: unknown },
  loops: readonly RunLoopState[]
): RunProcessView | null {
  const parsedSnapshot = runProcessSnapshotSchema.safeParse(run.process);
  if (!parsedSnapshot.success) {
    return null;
  }
  const snapshot = parsedSnapshot.data;
  const { definition } = snapshot;
  const parsedState = runStepStateSchema.safeParse(run.stepState);
  const state = parsedState.success ? parsedState.data : null;
  const approvalStep = state?.approval
    ? definition.steps.find((step) => step.id === state.approval?.stepId)
    : undefined;
  return {
    version: snapshot.version,
    source: snapshot.source,
    toolkit: definition.toolkit?.repository ?? null,
    steps: definition.steps.map((step) => ({
      id: step.id,
      name: step.name,
      type: step.type,
    })),
    stepId: run.stepId,
    waiting: state?.waiting
      ? {
          stepId: state.waiting.stepId,
          questions: state.waiting.questions,
          askedAt: state.waiting.askedAt,
          answered: state.waiting.answers !== null,
        }
      : null,
    approval: state?.approval
      ? {
          stepId: state.approval.stepId,
          requestedAt: state.approval.requestedAt,
          show:
            approvalStep?.type === ProcessStepType.Approval
              ? approvalStep.show
              : [],
          decided: state.approval.decision !== null,
        }
      : null,
    review: reviewView(definition.steps, state?.review ?? null),
    stepFiles: latestStepFiles(loops),
  };
}

/** The step under review as the run page shows it; null when none. */
function reviewView(
  steps: readonly ProcessStep[],
  review: RunStepState["review"] | null
): RunProcessView["review"] {
  const step = review
    ? steps.find((candidate) => candidate.id === review.stepId)
    : undefined;
  if (!(review && step?.type === ProcessStepType.Agent && step.review)) {
    return null;
  }
  return {
    stepId: review.stepId,
    round: review.round,
    planStep: step.role === ProcessStepRole.Plan,
    waiting: review.requestedAt !== "" && review.decision === null,
    requestedAt: review.requestedAt,
    goOnLabels: reviewGoOnLabels(step.review),
    feedbackLabels: step.review.feedback.labels,
    mention: step.review.feedback.mention,
    history: review.decision
      ? [...review.history, review.decision]
      : review.history,
  };
}

/** The files of the latest completed loop of each agent step, in step order of the loops. */
function latestStepFiles(
  loops: readonly RunLoopState[]
): RunProcessView["stepFiles"] {
  const byStep = new Map<string, RunProcessView["stepFiles"][number]>();
  for (const loop of loops) {
    if (loop.command !== LoopCommand.Step || !loop.stepId) {
      continue;
    }
    const uploaded = uploadedStepSchema.safeParse(loop.uploadedArtifacts);
    const files = uploaded.success
      ? uploaded.data[LOOP_STEP_ARTIFACT_KEY].files
      : [];
    if (files.length > 0) {
      byStep.set(loop.stepId, {
        stepId: loop.stepId,
        loopId: loop.loopId,
        files,
      });
    }
  }
  return [...byStep.values()];
}

/** Longest {{reply}} handed to post actions (a Jira comment holds ~32k). */
export const RUN_REPLY_MAX_CHARS = 30_000;

export type RunReplies = {
  /** {{reply}}: the latest step's reply. */
  reply: string | null;
  /** {{steps.<id>.reply}}: each step's reply, by step id. */
  byStep: Record<string, string>;
};

/**
 * The run's replies: the content of each agent step's reply file
 * (AgentProcessStep.reply) from its latest loop that collected it, and the
 * one of the latest such step as {{reply}}. Empty for a run without a
 * process, or when no step wrote its reply file.
 */
export function findRunReplies(
  process: unknown,
  loops: readonly RunLoopState[]
): RunReplies {
  const replies: RunReplies = { reply: null, byStep: {} };
  const parsedSnapshot = runProcessSnapshotSchema.safeParse(process);
  if (!parsedSnapshot.success) {
    return replies;
  }
  const replyPaths = new Map<string, string>();
  for (const step of parsedSnapshot.data.definition.steps) {
    if (step.type === ProcessStepType.Agent && step.reply) {
      replyPaths.set(step.id, step.reply);
    }
  }
  for (const entry of latestStepFiles(loops)) {
    const path = replyPaths.get(entry.stepId);
    const file = path
      ? entry.files.find((candidate) => candidate.path === path)
      : undefined;
    const content = file?.content.trim();
    if (content) {
      const reply = capReply(content);
      replies.byStep[entry.stepId] = reply;
      replies.reply = reply;
    }
  }
  return replies;
}

function capReply(reply: string): string {
  return reply.length > RUN_REPLY_MAX_CHARS
    ? `${reply.slice(0, RUN_REPLY_MAX_CHARS - 1)}…`
    : reply;
}

const uploadedStepSchema = z.object({
  [LOOP_STEP_ARTIFACT_KEY]: LoopStepResultSchema,
});
