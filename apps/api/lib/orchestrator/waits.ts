import {
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import { withDb } from "@repo/database";
import { z } from "zod";
import { describeTaskFiles } from "./task-files";
import { readTaskResult, type TaskResult } from "./task-result";

/**
 * What a conversation waits for before its next turn (docs/orchestrator.md):
 * `all` or `any` of the tasks a turn started, with an optional deadline. The
 * engine evaluates a wait in code, never by waking the orchestrator: a task
 * that finished while the others still run is only recorded; once the
 * condition holds (or a task failed, with wakeOnFailure, or the deadline
 * passed) the wait fires once, an internal message carries the tasks'
 * results, and the conversation's next turn is due at once.
 */

const ANSWER_PREVIEW_MAX = 8000;
const DEADLINE_LIMIT = 50;

const taskIdsSchema = z.array(z.string());

const FINISHED: ReadonlySet<string> = new Set<string>([
  OrchestratorTaskStatus.Succeeded,
  OrchestratorTaskStatus.Failed,
  OrchestratorTaskStatus.Cancelled,
]);

export async function createWait(
  input: {
    organizationId: string;
    conversationId: string;
    kind: OrchestratorWaitKind;
    taskIds: string[];
    timeoutMinutes: number | null;
    wakeOnFailure: boolean;
  },
  now: Date
): Promise<string> {
  const wait = await withDb((db) =>
    db.orchestratorWait.create({
      data: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        kind: input.kind,
        taskIds: input.taskIds,
        deadline: input.timeoutMinutes
          ? new Date(now.getTime() + input.timeoutMinutes * 60_000)
          : null,
        wakeOnFailure: input.wakeOnFailure,
      },
      select: { id: true },
    })
  );
  return wait.id;
}

/** Fires the conversation's waits whose condition holds; true when one did. */
export async function evaluateWaits(
  conversationId: string,
  now: Date
): Promise<boolean> {
  const waits = await withDb((db) =>
    db.orchestratorWait.findMany({
      where: { conversationId, firedAt: null },
      orderBy: { createdAt: "asc" },
    })
  );
  let fired = false;
  for (const wait of waits) {
    if (await evaluateWait(wait, now)) {
      fired = true;
    }
  }
  return fired;
}

/** The tick: waits whose deadline passed. */
export async function fireDueDeadlines(now: Date): Promise<number> {
  const due = await withDb((db) =>
    db.orchestratorWait.findMany({
      where: { firedAt: null, deadline: { lte: now } },
      orderBy: { deadline: "asc" },
      take: DEADLINE_LIMIT,
    })
  );
  let fired = 0;
  for (const wait of due) {
    if (await evaluateWait(wait, now)) {
      fired += 1;
    }
  }
  return fired;
}

type WaitRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  kind: string;
  taskIds: unknown;
  deadline: Date | null;
  wakeOnFailure: boolean;
};

type WaitTask = {
  id: string;
  command: string;
  args: string;
  status: string;
  result: unknown;
  computeTarget: { machineName: string } | null;
};

async function evaluateWait(wait: WaitRow, now: Date): Promise<boolean> {
  const ids = taskIdsSchema.catch([]).parse(wait.taskIds);
  const tasks = await withDb((db) =>
    db.orchestratorTask.findMany({
      where: { id: { in: ids }, organizationId: wait.organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        command: true,
        args: true,
        status: true,
        result: true,
        computeTarget: { select: { machineName: true } },
      },
    })
  );
  const reason = waitReason(wait, tasks, now);
  if (!reason) {
    return false;
  }
  const claimed = await withDb((db) =>
    db.orchestratorWait.updateMany({
      where: { id: wait.id, firedAt: null },
      data: { firedAt: now },
    })
  );
  if (claimed.count !== 1) {
    return false;
  }
  await withDb.tx(async (tx) => {
    await tx.orchestratorMessage.create({
      data: {
        organizationId: wait.organizationId,
        conversationId: wait.conversationId,
        origin: OrchestratorMessageOrigin.Internal,
        kind:
          reason === WaitReason.Deadline
            ? OrchestratorMessageKind.Deadline
            : OrchestratorMessageKind.TaskResults,
        actor: null,
        text: describeResults(reason, wait, tasks),
        dedupKey: `wait:${wait.id}`,
        payload: { waitId: wait.id, taskIds: ids },
      },
    });
    await tx.orchestratorConversation.update({
      where: { id: wait.conversationId },
      data: { nextWakeAt: now },
    });
  });
  return true;
}

const WaitReason = {
  Done: "done",
  Cancelled: "cancelled",
  Failure: "failure",
  Deadline: "deadline",
} as const;
type WaitReason = (typeof WaitReason)[keyof typeof WaitReason];

/** Why the wait fires now, or null while it keeps waiting. */
export function waitReason(
  wait: Pick<WaitRow, "kind" | "deadline" | "wakeOnFailure">,
  tasks: readonly Pick<WaitTask, "status">[],
  now: Date
): WaitReason | null {
  const finished = tasks.filter((task) => FINISHED.has(task.status));
  const done =
    wait.kind === OrchestratorWaitKind.Any
      ? finished.length > 0
      : finished.length === tasks.length;
  const cancelled = tasks.some(
    (task) => task.status === OrchestratorTaskStatus.Cancelled
  );
  const succeeded = finished.some(
    (task) => task.status !== OrchestratorTaskStatus.Cancelled
  );
  if (done && cancelled && !succeeded) {
    return WaitReason.Cancelled;
  }
  if (done) {
    return WaitReason.Done;
  }
  if (cancelled) {
    return WaitReason.Cancelled;
  }
  if (
    wait.wakeOnFailure &&
    tasks.some((task) => task.status === OrchestratorTaskStatus.Failed)
  ) {
    return WaitReason.Failure;
  }
  if (wait.deadline && wait.deadline <= now) {
    return WaitReason.Deadline;
  }
  return null;
}

function describeResults(
  reason: WaitReason,
  wait: Pick<WaitRow, "kind">,
  tasks: WaitTask[]
): string {
  const heading = {
    [WaitReason.Done]: `The tasks you waited for (${wait.kind}) are done.`,
    [WaitReason.Cancelled]:
      "A task you waited for was cancelled when the ticket changed; the others may still run.",
    [WaitReason.Failure]:
      "A task you waited for failed; the others may still run.",
    [WaitReason.Deadline]:
      "The time you gave the tasks is up; here is where they are.",
  }[reason];
  return [heading, ...tasks.map(describeTask)].join("\n\n");
}

function describeTask(task: WaitTask): string {
  const result = readTaskResult(task.result);
  const head = `- Task ${task.id}: \`${[task.command, task.args].filter(Boolean).join(" ")}\` on ${task.computeTarget?.machineName ?? "a removed runner"}: ${statusText(task, result)}`;
  const lines = [head];
  if (result?.reply) {
    lines.push(
      `  Answer:\n${indent(result.reply.slice(0, ANSWER_PREVIEW_MAX))}`
    );
  } else if (FINISHED.has(task.status)) {
    lines.push("  (no answer file)");
  }
  const filesText = describeTaskFiles(
    result?.files ?? [],
    result?.filesOmitted ?? 0
  );
  if (filesText) {
    lines.push(`  ${filesText}`);
  }
  lines.push(...questionLines(task, result));
  if (result?.error) {
    lines.push(`  Error: ${result.error}`);
  }
  if (task.status === OrchestratorTaskStatus.Queued && result?.waiting) {
    lines.push(`  Waiting: ${result.waiting}`);
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function statusText(task: WaitTask, result: TaskResult | null): string {
  if (task.status === OrchestratorTaskStatus.Cancelled) {
    return `cancelled: ${result?.cancelled ?? "no reason given"}`;
  }
  return task.status;
}

function questionLines(task: WaitTask, result: TaskResult | null): string[] {
  if (!result?.questions.length) {
    return [];
  }
  const hint =
    task.status === OrchestratorTaskStatus.Cancelled
      ? "  It was cancelled: do not resume it; start a new task if the work is still needed."
      : `  To answer, run a task with resumeTaskId ${task.id} and the answers as its prompt.`;
  return [
    "  Questions it asks:",
    ...result.questions.map(
      (question) =>
        `  - ${question.id}: ${question.question}${question.options?.length ? ` (options: ${question.options.join(" | ")})` : ""}`
    ),
    hint,
  ];
}
