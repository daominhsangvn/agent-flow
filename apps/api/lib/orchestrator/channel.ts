import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { z } from "zod";
import type { InboundEvent, SourceItemRef } from "@/lib/integrations/types";
import { jsonObjectSchema } from "@/lib/json-schema";

/**
 * Where an orchestrator conversation talks (docs/orchestrator.md): the source
 * item it answers on, the comment whose thread it answers in, and what the
 * provider left for answers (Teams: the thread's service URL and requester).
 * Stored as `orchestrator_conversations.channel`.
 */

export const conversationChannelSchema = z.object({
  item: z.object({
    provider: z.string(),
    externalId: z.string(),
    key: z.string(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    container: z.string().nullable(),
  }),
  parentId: z.string().nullable(),
  extras: jsonObjectSchema.nullable(),
});
export type ConversationChannel = z.infer<typeof conversationChannelSchema>;

/** The case a source item belongs to: one per item per project. */
export function caseSourceKey(item: SourceItemRef): string {
  return `${item.provider}:${item.key}`;
}

/**
 * The conversation an inbound message belongs to, by where it was written:
 * a Teams thread is one conversation; on a Jira issue a comment thread is one
 * and the issue's top level another. `parentId` is the comment replied to.
 */
export function channelKeyFor(
  item: SourceItemRef,
  parentId: string | null
): string {
  const source = caseSourceKey(item);
  if (item.provider === IntegrationProviderKey.MicrosoftTeams) {
    return source;
  }
  return parentId ? `${source}:comment:${parentId}` : `${source}:item`;
}

/** The channel of a new conversation, from the event that opened it. */
export function channelFromEvent(
  event: InboundEvent,
  parentId: string | null
): ConversationChannel {
  return {
    item: {
      provider: event.item.provider,
      externalId: event.item.externalId,
      key: event.item.key,
      url: event.item.url,
      title: event.item.title,
      container: event.item.container,
    },
    parentId,
    extras: event.extras ?? null,
  };
}

/** A stored channel, or null when it no longer parses. */
export function readChannel(value: unknown): ConversationChannel | null {
  const parsed = conversationChannelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The newest extras win: Teams names whoever asked last, so answers mention
 * them.
 */
export function withLatestExtras(
  channel: ConversationChannel,
  extras: JsonObject | undefined
): ConversationChannel {
  return extras ? { ...channel, extras } : channel;
}
