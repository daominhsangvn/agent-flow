import { OrchestratorTaskStatus } from "@repo/api/src/types/orchestrator";
import { Result } from "@repo/api/src/types/result";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { cancelLoop } from "@/lib/workflows/engine/cancel";
import { readTaskResult, type TaskResult } from "./task-result";
import { evaluateWaits } from "./waits";
import { loadOrchestratorWorkflows } from "./workflow-settings";

/**
 * task_cancel (docs/orchestrator.md): only a ticket change listed in the
 * workflow's `agent.orchestrator.cancelOn` cancels tasks. A comment, question
 * or reply on this or any ticket never does: the turn must have taken a
 * message whose kind is in cancelOn. A running task's loop is stopped, a
 * queued one never starts, a finished one is closed (it cannot be resumed),
 * and the waits of the case wake at once.
 */

const LOG_PREFIX = "[orchestrator/task-cancel]";

export type CancelTaskInput = {
  organizationId: string;
  caseId: string;
  turnId: string;
  taskId: string;
  reason: string;
};

export type CancelTaskOutcome = {
  taskId: string;
  previous: OrchestratorTaskStatus;
  alreadyCancelled: boolean;
  loopStopped: boolean;
};

export function cancelOnRefusal(cancelOn: readonly string[]): string {
  if (cancelOn.length === 0) {
    return "cancelOn allows nothing: this workflow's orchestrator never cancels tasks.";
  }
  return `Only a ticket change listed in agent.orchestrator.cancelOn cancels tasks (cancelOn allows: ${cancelOn.join(", ")}); this turn handles none, so the task keeps running.`;
}

export async function cancelTask(
  input: CancelTaskInput,
  now = new Date()
): Promise<Result<CancelTaskOutcome, string>> {
  const { organizationId, caseId, turnId, taskId, reason } = input;
  const cancelOn = await readCancelOn(organizationId, caseId);
  if (cancelOn.length === 0) {
    return Result.err(cancelOnRefusal(cancelOn));
  }
  const changes = await withDb((db) =>
    db.orchestratorMessage.count({
      where: { turnId, kind: { in: [...cancelOn] } },
    })
  );
  if (changes === 0) {
    return Result.err(cancelOnRefusal(cancelOn));
  }
  const task = await withDb((db) =>
    db.orchestratorTask.findFirst({
      where: { id: taskId, caseId, organizationId },
      select: {
        id: true,
        status: true,
        loopId: true,
        computeTargetId: true,
        result: true,
      },
    })
  );
  if (!task) {
    return Result.err("No task of this case has that id.");
  }
  const previous = task.status as OrchestratorTaskStatus;
  if (previous === OrchestratorTaskStatus.Cancelled) {
    return Result.ok({
      taskId,
      previous,
      alreadyCancelled: true,
      loopStopped: false,
    });
  }
  const result: TaskResult = {
    ...(readTaskResult(task.result) ?? {
      reply: null,
      questions: [],
      error: null,
    }),
    waiting: null,
    cancelled: reason,
    cancelledFrom: previous,
  };
  const claimed = await withDb((db) =>
    db.orchestratorTask.updateMany({
      where: { id: taskId, status: previous },
      data: {
        status: OrchestratorTaskStatus.Cancelled,
        finishedAt: now,
        result: result as Prisma.InputJsonValue,
      },
    })
  );
  if (claimed.count === 0) {
    return Result.err(
      "The task changed meanwhile: read it with task_get and try again."
    );
  }
  const loopStopped = await stopLoop(task, previous, organizationId, reason);
  await wakeCaseWaits(organizationId, caseId, now);
  return Result.ok({ taskId, previous, alreadyCancelled: false, loopStopped });
}

/** The message a resume of a cancelled task is refused with, or null. */
export function taskCancelledMessage(result: TaskResult | null): string | null {
  if (!result?.cancelled) {
    return null;
  }
  return `Task was cancelled (${result.cancelled}) when the ticket changed: do not resume it; start a new task if the work is still needed.`;
}

async function readCancelOn(
  organizationId: string,
  caseId: string
): Promise<readonly string[]> {
  const found = await withDb((db) =>
    db.orchestratorCase.findFirst({
      where: { id: caseId, organizationId },
      select: { workflowId: true },
    })
  );
  if (!found) {
    return [];
  }
  const workflows = await loadOrchestratorWorkflows(organizationId, [
    found.workflowId,
  ]);
  return workflows.get(found.workflowId)?.cancelOn ?? [];
}

/** Stops a running task's loop (best effort); false when it was not stopped. */
async function stopLoop(
  task: { loopId: string | null; computeTargetId: string | null },
  previous: OrchestratorTaskStatus,
  organizationId: string,
  reason: string
): Promise<boolean> {
  if (previous !== OrchestratorTaskStatus.Running || !task.loopId) {
    return false;
  }
  try {
    return await cancelLoop(
      task.loopId,
      task.computeTargetId,
      organizationId,
      `Cancelled by the orchestrator: ${reason}`
    );
  } catch (error) {
    log.warn(`${LOG_PREFIX} the task's loop could not be stopped`, {
      loopId: task.loopId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Evaluates the open waits of every conversation of the case, one by one. */
async function wakeCaseWaits(
  organizationId: string,
  caseId: string,
  now: Date
): Promise<void> {
  const waits = await withDb((db) =>
    db.orchestratorWait.findMany({
      where: { organizationId, firedAt: null, conversation: { caseId } },
      select: { conversationId: true },
      distinct: ["conversationId"],
    })
  );
  for (const wait of waits) {
    await evaluateWaits(wait.conversationId, now);
  }
}
