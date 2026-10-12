import {
  type AnswerStepQuestionsInput,
  type DecidedStepApproval,
  type RunStepState,
  runStepStateSchema,
} from "@repo/api/src/types/project-process";
import { Result, Status } from "@repo/api/src/types/result";
import {
  type WorkflowRunDetail,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { type Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { waitUntil } from "@/lib/wait-until";
import { advanceRun } from "./engine/advance";
import { type RunServiceError, workflowRunService } from "./run-service";

/**
 * What a person gives a run waiting on a process step (docs/workflows.md
 * "Project process"): the answers to an agent step's questions, or the
 * decision of an approval step. The decision is recorded on the run's step
 * state; the engine (advance.ts) acts on it, so this module never writes a
 * run status itself.
 */

export const workflowRunStepInputService = {
  /**
   * Records the answers to the questions of the waiting agent step; the step
   * resumes its agent session with them. Every question must be answered
   * at most once; questions left out are decided by the agent.
   */
  async answerQuestions(
    organizationId: string,
    userId: string,
    runId: string,
    input: AnswerStepQuestionsInput
  ): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    const run = await loadRun(organizationId, runId);
    if (!run) {
      return notFound();
    }
    const state = readStepState(run.stepState);
    const waiting = state?.waiting;
    if (!(state && waiting) || run.status !== WorkflowRunStatus.NeedsInput) {
      return conflict("The run is not waiting for answers.");
    }
    if (waiting.answers) {
      return conflict("The questions were already answered.");
    }
    const known = new Set(waiting.questions.map((question) => question.id));
    const unknown = input.answers.find((answer) => !known.has(answer.id));
    if (unknown) {
      return badRequest(`Unknown question: ${unknown.id}`);
    }
    if (
      new Set(input.answers.map((answer) => answer.id)).size !==
      input.answers.length
    ) {
      return badRequest("Each question can be answered once.");
    }
    const next: RunStepState = {
      ...state,
      waiting: { ...waiting, answers: input.answers, answeredBy: userId },
    };
    return await record(
      organizationId,
      run,
      WorkflowRunStatus.NeedsInput,
      next
    );
  },

  /** Records the decision of the approval step the run waits for. */
  async decideApproval(
    organizationId: string,
    userId: string,
    runId: string,
    input: DecidedStepApproval
  ): Promise<Result<WorkflowRunDetail, RunServiceError>> {
    const run = await loadRun(organizationId, runId);
    if (!run) {
      return notFound();
    }
    const state = readStepState(run.stepState);
    const approval = state?.approval;
    if (
      !(state && approval) ||
      run.status !== WorkflowRunStatus.NeedsApproval
    ) {
      return conflict("The run is not waiting for an approval.");
    }
    if (approval.decision) {
      return conflict("The step was already decided.");
    }
    const next: RunStepState = {
      ...state,
      approval: {
        ...approval,
        decision: {
          approved: input.approved,
          comment: input.comment,
          decidedBy: userId,
          decidedAt: new Date().toISOString(),
        },
      },
    };
    return await record(
      organizationId,
      run,
      WorkflowRunStatus.NeedsApproval,
      next
    );
  },
};

type StepInputRun = {
  id: string;
  status: string;
  stepState: Prisma.JsonValue;
};

const uuidSchema = z.uuid();

async function loadRun(
  organizationId: string,
  runId: string
): Promise<StepInputRun | null> {
  if (!uuidSchema.safeParse(runId).success) {
    return null;
  }
  return await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: runId, organizationId },
      select: { id: true, status: true, stepState: true },
    })
  );
}

/**
 * Writes the new step state only if the run is still where it was read (same
 * status, same step state), then advances it in the background.
 */
async function record(
  organizationId: string,
  run: StepInputRun,
  status: WorkflowRunStatus,
  next: RunStepState
): Promise<Result<WorkflowRunDetail, RunServiceError>> {
  const updated = await withDb((db) =>
    db.workflowRun.updateMany({
      where: {
        id: run.id,
        organizationId,
        status,
        stepState: { equals: run.stepState as Prisma.InputJsonValue },
      },
      data: { stepState: next, nextStepAt: null },
    })
  );
  if (updated.count === 0) {
    return conflict(
      "The run changed in the meantime. Reload it and try again."
    );
  }
  waitUntil(advanceRun(run.id));
  const detail = await workflowRunService.get(organizationId, run.id);
  return detail ? Result.ok(detail) : notFound();
}

function notFound<T>(): Result<T, RunServiceError> {
  return Result.err({
    status: Status.NotFound,
    message: "Workflow run not found",
  });
}

function conflict<T>(message: string): Result<T, RunServiceError> {
  return Result.err({ status: Status.Conflict, message });
}

function badRequest<T>(message: string): Result<T, RunServiceError> {
  return Result.err({ status: Status.BadRequest, message });
}

function readStepState(value: unknown): RunStepState | null {
  const parsed = runStepStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
