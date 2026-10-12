import {
  LOOP_STEP_OPTION_MAX,
  LOOP_STEP_OPTIONS_MAX,
  LOOP_STEP_QUESTION_MAX,
  LOOP_STEP_QUESTIONS_MAX,
  LOOP_STEP_WORK_DIR,
  LoopStepFile,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  type AgentProcessStep,
  type ProcessAnswer,
  ProcessStepType,
  type RunStepState,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowAgentConfig,
  WorkflowRunErrorCode,
  type WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import type { SourceItem } from "@/lib/integrations/types";
import { STEP_ISSUE_FILE, toLoopStepConfig } from "./agent-step";
import { runError } from "./errors";
import { launchStepLoop } from "./launch-step";
import { readRunProcessSnapshot } from "./process";
import { toJsonObject } from "./run-data";
import { findLatestRunLoop, listRunLoops } from "./run-loops";
import {
  type EngineRun,
  failRun,
  type RunTransitionData,
  type StepOutcome,
  transition,
} from "./step-outcome";

/**
 * Answers to the questions of a waiting agent step (docs/workflows.md
 * "Project process"): a new STEP loop continues the asking loop's agent
 * session (its parent loop; the computer resumes the session with
 * `--resume`) with the answers as its prompt, on the same computer and in
 * the same workspace. Answers come from AgentFlow (POST
 * /workflow-runs/{id}/answers) or from the source item's comments when it
 * triggers the run again.
 */

type WaitingStep = NonNullable<RunStepState["waiting"]>;

export type ResumeAgentStepInput = {
  run: EngineRun;
  agent: WorkflowAgentConfig;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
  waiting: WaitingStep;
  /** The answers, as the agent reads them. */
  prompt: string;
  /** Events of the transition back into the step. */
  events: WorkflowRunEvent[];
  /**
   * The cycle the resumed step runs in, when the answers start a new one
   * (given in AgentFlow; an item that re-triggers the run already did).
   */
  cycle?: number;
};

export async function resumeAgentStep(
  input: ResumeAgentStepInput
): Promise<StepOutcome> {
  const { run, waiting, events } = input;
  const snapshot = readRunProcessSnapshot(run.process);
  const step = snapshot?.definition.steps.find(
    (candidate): candidate is AgentProcessStep =>
      candidate.id === waiting.stepId &&
      candidate.type === ProcessStepType.Agent
  );
  const documentId = run.planDocumentId ?? run.featureDocumentId;
  if (!(snapshot && step && documentId)) {
    return failRun(
      runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        "The waiting process step could not be read, so the answers cannot be passed on."
      ),
      events
    );
  }
  const data: RunTransitionData = {
    stepId: step.id,
    stepState: null,
    ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
  };
  // A retry after a crash between the launch and the status write.
  const launched = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    run.phaseStartedAt,
    step.id
  );
  if (launched) {
    return transition(WorkflowRunStatus.Running, events, data);
  }
  const askingLoop = (await listRunLoops(run.id)).find(
    (loop) => loop.loopId === waiting.loopId
  );
  const launch = await launchStepLoop({
    runId: run.id,
    organizationId: run.organizationId,
    projectId: input.projectId,
    runAsUser: input.runAsUser,
    documentId,
    agent: input.agent,
    step: toLoopStepConfig({
      runId: run.id,
      step,
      toolkit: snapshot.definition.toolkit,
      fresh: false,
    }),
    prompt: input.prompt,
    computeTargetId: askingLoop?.computeTargetId ?? null,
    resumeLoopId: waiting.loopId,
  });
  if (!launch.ok) {
    return failRun(launch.error, events);
  }
  return transition(WorkflowRunStatus.Running, events, data);
}

/** The prompt of answers given in AgentFlow. */
export function answersPrompt(
  waiting: WaitingStep,
  answers: readonly ProcessAnswer[]
): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer.answer]));
  const lines = waiting.questions.map((question) => {
    const answer = byId.get(question.id) ?? "(no answer: decide yourself)";
    return `- ${question.question}\n  Answer: ${answer}`;
  });
  return [
    "The developer answered your questions:",
    "",
    ...lines,
    "",
    "Continue the step with these answers. Do not ask these questions again.",
  ].join("\n");
}

/**
 * The prompt of answers given on the source item: its comments written after
 * the step asked, else a pointer to the refreshed Issue.
 */
export function ticketAnswersPrompt(
  waiting: WaitingStep,
  item: SourceItem
): string {
  const askedAt = Date.parse(waiting.askedAt);
  const comments = item.comments.filter((comment) => {
    const at = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
    return Number.isFinite(at) && at > askedAt;
  });
  const questions = waiting.questions.map(
    (question) => `- ${question.question}`
  );
  const answers =
    comments.length > 0
      ? comments.map(
          (comment) =>
            `${comment.author ?? "Someone"}: ${comment.bodyMarkdown.trim()}`
        )
      : [
          `The developer updated the issue instead; re-read ${STEP_ISSUE_FILE}.`,
        ];
  return [
    "You asked the developer:",
    ...questions,
    "",
    "They answered on the issue:",
    "",
    ...answers,
    "",
    `The updated issue is in ${STEP_ISSUE_FILE}. Continue the step with these answers. Do not ask these questions again.`,
  ].join("\n");
}

export type RepairStepQuestionsInput = {
  run: EngineRun;
  agent: WorkflowAgentConfig;
  projectId: string;
  runAsUser: { id: string; clerkId: string };
  step: AgentProcessStep;
  /** The loop whose questions could not be read; its session is resumed. */
  loopId: string;
  error: string;
  /** Repair attempts including this one (RunStepState.questionsRepair). */
  attempts: number;
  /** Columns the settled step already set (pushed branches). */
  data: RunTransitionData;
};

/**
 * Questions that could not be read (too long, not JSON, ...) do not fail the
 * step outright: the asking session is resumed on its computer to rewrite
 * them within the limits (QUESTIONS_REPAIR_MAX times). The run stays
 * `running`; the step settles again when that loop ends.
 */
export async function repairStepQuestions(
  input: RepairStepQuestionsInput
): Promise<StepOutcome> {
  const { run, step } = input;
  const snapshot = readRunProcessSnapshot(run.process);
  const documentId = run.planDocumentId ?? run.featureDocumentId;
  if (!(snapshot && documentId)) {
    return failRun(
      runError(
        WorkflowRunErrorCode.AgentConfigInvalid,
        "The process step could not be read, so its questions cannot be rewritten."
      )
    );
  }
  const state: RunStepState = {
    waiting: null,
    approval: null,
    questionsRepair: {
      stepId: step.id,
      loopId: input.loopId,
      attempts: input.attempts,
    },
  };
  const data: RunTransitionData = {
    ...input.data,
    stepState: toJsonObject(state),
  };
  // A retry after a crash between the launch and the status write: the
  // step's latest loop is then the repair, not the loop that wrote them.
  const latest = await findLatestRunLoop(
    run.id,
    LoopCommand.Step,
    undefined,
    step.id
  );
  if (latest && latest.loopId !== input.loopId) {
    return transition(WorkflowRunStatus.Running, [], data);
  }
  const writer = (await listRunLoops(run.id)).find(
    (loop) => loop.loopId === input.loopId
  );
  const launch = await launchStepLoop({
    runId: run.id,
    organizationId: run.organizationId,
    projectId: input.projectId,
    runAsUser: input.runAsUser,
    documentId,
    agent: input.agent,
    step: toLoopStepConfig({
      runId: run.id,
      step,
      toolkit: snapshot.definition.toolkit,
      fresh: false,
    }),
    prompt: questionsRepairPrompt(input.error),
    computeTargetId: writer?.computeTargetId ?? null,
    resumeLoopId: input.loopId,
  });
  if (!launch.ok) {
    return failRun(launch.error);
  }
  return transition(WorkflowRunStatus.Running, [], data);
}

/** What the resumed session is told when its questions could not be read. */
export function questionsRepairPrompt(error: string): string {
  const file = `${LOOP_STEP_WORK_DIR}/${LoopStepFile.Questions}`;
  return [
    `Your questions could not be read from ${file}: ${error}`,
    "",
    `Rewrite ${file} as a JSON array of {"id": "q1", "question": "...", "options": ["..."]} within these limits: at most ${LOOP_STEP_QUESTIONS_MAX} questions; each question at most ${LOOP_STEP_QUESTION_MAX} characters; at most ${LOOP_STEP_OPTIONS_MAX} options per question, each at most ${LOOP_STEP_OPTION_MAX} characters. Keep the options short and put the reasoning in the question.`,
    "Keep the same questions and change nothing else, then stop.",
  ].join("\n");
}
