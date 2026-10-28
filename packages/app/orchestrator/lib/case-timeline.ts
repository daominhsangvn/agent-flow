import type {
  OrchestratorCaseConversation,
  OrchestratorCaseMessage,
  OrchestratorCaseTask,
  OrchestratorCaseTurn,
} from "@repo/api/src/types/orchestrator";

export const CaseTimelineEntryKind = {
  Message: "message",
  Turn: "turn",
} as const;
export type CaseTimelineEntryKind =
  (typeof CaseTimelineEntryKind)[keyof typeof CaseTimelineEntryKind];

export type CaseTimelineEntry =
  | {
      kind: typeof CaseTimelineEntryKind.Message;
      at: string;
      message: OrchestratorCaseMessage;
    }
  | {
      kind: typeof CaseTimelineEntryKind.Turn;
      at: string;
      turn: OrchestratorCaseTurn;
      tasks: OrchestratorCaseTask[];
    };

export type ConversationTimeline = {
  entries: CaseTimelineEntry[];
  /** Tasks whose turn is not in the loaded list (or that have no turn). */
  unassignedTasks: OrchestratorCaseTask[];
};

/**
 * Merges a conversation's messages and turns by time. Each turn carries the
 * tasks it started; tasks of this conversation without a loaded turn go to
 * `unassignedTasks`.
 */
export function buildConversationTimeline(
  conversation: OrchestratorCaseConversation,
  tasks: OrchestratorCaseTask[]
): ConversationTimeline {
  const own = tasks.filter((task) => task.conversationId === conversation.id);
  const turnIds = new Set(conversation.turns.map((turn) => turn.id));

  const entries: CaseTimelineEntry[] = [
    ...conversation.messages.map(
      (message): CaseTimelineEntry => ({
        kind: CaseTimelineEntryKind.Message,
        at: message.createdAt,
        message,
      })
    ),
    ...conversation.turns.map(
      (turn): CaseTimelineEntry => ({
        kind: CaseTimelineEntryKind.Turn,
        at: turn.startedAt,
        turn,
        tasks: own.filter((task) => task.turnId === turn.id),
      })
    ),
  ];
  entries.sort(compareEntries);

  return {
    entries,
    unassignedTasks: own.filter(
      (task) => task.turnId === null || !turnIds.has(task.turnId)
    ),
  };
}

export function entryId(entry: CaseTimelineEntry): string {
  return entry.kind === CaseTimelineEntryKind.Message
    ? entry.message.id
    : entry.turn.id;
}

function compareEntries(a: CaseTimelineEntry, b: CaseTimelineEntry): number {
  const byTime = new Date(a.at).getTime() - new Date(b.at).getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return entryId(a).localeCompare(entryId(b));
}
