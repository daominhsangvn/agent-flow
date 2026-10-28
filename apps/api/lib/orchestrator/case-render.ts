import {
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
} from "@repo/api/src/types/orchestrator";
import { withDb } from "@repo/database";
import { readChannel } from "./channel";
import { readTaskResult } from "./task-result";
import { isTicketChangeKind } from "./ticket-change";

/**
 * CASE.md: a case as the database knows it, rendered for the orchestrator's
 * prompt and `case_get` (docs/orchestrator.md). The orchestrator's session is
 * a cache; this is the record a turn trusts. Each task line says what started
 * it (a status, a label or a message), so task_cancel can stop the right ones.
 */

const RECENT_MESSAGES = 5;
const RECENT_TASKS = 20;
const TEXT_PREVIEW = 600;
const STARTED_FOR_MESSAGES = 10;

export async function renderCase(caseId: string): Promise<string> {
  const found = await withDb((db) =>
    db.orchestratorCase.findUnique({
      where: { id: caseId },
      select: {
        title: true,
        status: true,
        sourceKey: true,
        notes: true,
        conversations: {
          orderBy: { createdAt: "asc" },
          select: {
            channelKey: true,
            status: true,
            channel: true,
            messages: {
              orderBy: { createdAt: "desc" },
              take: RECENT_MESSAGES,
              select: { actor: true, kind: true, text: true, createdAt: true },
            },
          },
        },
        tasks: {
          orderBy: { createdAt: "desc" },
          take: RECENT_TASKS,
          select: {
            id: true,
            command: true,
            args: true,
            mode: true,
            status: true,
            result: true,
            computeTarget: { select: { machineName: true } },
            conversation: { select: { channelKey: true } },
            turn: {
              select: {
                messages: {
                  where: { origin: OrchestratorMessageOrigin.External },
                  orderBy: { createdAt: "asc" },
                  take: STARTED_FOR_MESSAGES,
                  select: { kind: true, text: true },
                },
              },
            },
          },
        },
        decisions: {
          orderBy: { createdAt: "desc" },
          select: { id: true, question: true, status: true, decidedBy: true },
        },
      },
    })
  );
  if (!found) {
    return "(the case no longer exists)";
  }
  const lines = [
    `# ${found.title}`,
    `Status: ${found.status}${found.sourceKey ? ` · source ${found.sourceKey}` : ""}`,
    "",
    "## Notes",
    found.notes.trim() || "(none yet)",
    "",
    "## Conversations",
  ];
  for (const conversation of found.conversations) {
    const channel = readChannel(conversation.channel);
    lines.push(
      `### ${conversation.channelKey} (${conversation.status})${channel?.item.url ? ` ${channel.item.url}` : ""}`
    );
    for (const message of [...conversation.messages].reverse()) {
      lines.push(
        `- ${message.createdAt.toISOString()} ${message.actor ?? "AgentFlow"} (${message.kind}): ${preview(message.text)}`
      );
    }
  }
  lines.push("", "## Tasks");
  if (found.tasks.length === 0) {
    lines.push("(none)");
  }
  for (const task of found.tasks) {
    lines.push(
      `- ${task.id} ${task.command}${task.args ? ` ${task.args}` : ""} on ${task.computeTarget?.machineName ?? "a removed runner"} (${task.mode}): ${task.status}${taskNote(task)}${taskFilesNote(task)} — started for: ${startedFor(task)}`
    );
  }
  lines.push("", "## Decisions");
  if (found.decisions.length === 0) {
    lines.push("(none)");
  }
  for (const decision of found.decisions) {
    lines.push(
      `- ${decision.id} ${decision.status}${decision.decidedBy ? ` by ${decision.decidedBy}` : ""}: ${preview(decision.question)}`
    );
  }
  return lines.join("\n");
}

function preview(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > TEXT_PREVIEW ? `${flat.slice(0, TEXT_PREVIEW)}…` : flat;
}

/** Why a queued task waits, or why a failed one failed. */
function taskNote(task: { status: string; result: unknown }): string {
  const result = readTaskResult(task.result);
  if (task.status === OrchestratorTaskStatus.Queued && result?.waiting) {
    return ` — waiting: ${preview(result.waiting)}`;
  }
  if (task.status === OrchestratorTaskStatus.Failed && result?.error) {
    return ` — error: ${preview(result.error)}`;
  }
  if (task.status === OrchestratorTaskStatus.Cancelled && result?.cancelled) {
    return ` — cancelled: ${preview(result.cancelled)}`;
  }
  return "";
}

/** The names of the files a task left, or nothing. */
function taskFilesNote(task: { result: unknown }): string {
  const files = readTaskResult(task.result)?.files ?? [];
  if (files.length === 0) {
    return "";
  }
  const names = files.map((file) =>
    file.skipped ? `${file.name} (not collected)` : file.name
  );
  return ` — files: ${names.join(", ")}`;
}

type StartedForTask = {
  conversation: { channelKey: string } | null;
  turn: { messages: Array<{ kind: string; text: string }> } | null;
};

/** The ticket change (the last of the turn), message or channel that started a task. */
function startedFor(task: StartedForTask): string {
  const channelKey = task.conversation?.channelKey ?? "a removed conversation";
  const messages = task.turn?.messages ?? [];
  const changes = messages.filter((message) =>
    isTicketChangeKind(message.kind)
  );
  const change = changes.at(-1);
  if (change) {
    return `${change.kind} "${preview(change.text)}"`;
  }
  const last = messages.at(-1);
  if (last) {
    return `message in ${channelKey}: "${preview(last.text)}"`;
  }
  return channelKey;
}
