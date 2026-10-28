import { OrchestratorMessageOrigin } from "@repo/api/src/types/orchestrator";
import { withDb } from "@repo/database";
import { z } from "zod";

/**
 * Where an orchestrator reply goes in an item's comments (Jira threads have
 * one level, so a thread is its first comment).
 */

/**
 * The thread of the conversation's latest message from people; null (a new
 * comment) when that message is a ticket change or there is none.
 */
export async function latestMessageRef(
  conversationId: string
): Promise<string | null> {
  const latest = await withDb((db) =>
    db.orchestratorMessage.findFirst({
      where: {
        conversationId,
        origin: OrchestratorMessageOrigin.External,
      },
      orderBy: { createdAt: "desc" },
      select: { externalRef: true, payload: true },
    })
  );
  // A ticket change (a status or label change) is no comment: what answers
  // it is a new comment on the item, not a reply in an earlier thread.
  if (!latest?.externalRef) {
    return null;
  }
  const thread = messageThreadSchema.safeParse(latest.payload);
  return (thread.success ? thread.data.parentId : null) ?? latest.externalRef;
}

/**
 * The thread a reply to one of this conversation's messages goes in: its
 * thread's first comment (threads have one level), else the message itself.
 * null when the conversation has no such message.
 */
export async function messageThread(
  conversationId: string,
  externalRef: string
): Promise<string | null> {
  const message = await withDb((db) =>
    db.orchestratorMessage.findFirst({
      where: {
        conversationId,
        origin: OrchestratorMessageOrigin.External,
        externalRef,
      },
      select: { externalRef: true, payload: true },
    })
  );
  if (!message?.externalRef) {
    return null;
  }
  const thread = messageThreadSchema.safeParse(message.payload);
  return (thread.success ? thread.data.parentId : null) ?? message.externalRef;
}

const messageThreadSchema = z.object({
  parentId: z.string().min(1).nullable(),
});
