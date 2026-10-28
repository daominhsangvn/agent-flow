import { createHash } from "node:crypto";
import { Result } from "@repo/api/src/types/result";

/**
 * Identities of Teams channel threads. A run's source item is a thread (a
 * channel post and its replies): its key is stable per thread, so a second
 * mention in the same thread resumes or waits for the thread's run instead
 * of starting another. The externalId also names the message that mentioned
 * the bot, which is the request the run carries out:
 *
 *   externalId = "{teamId}|{channelId}|{rootMessageId}|{messageId}"
 *
 * teamId is the team's Microsoft 365 group id (Graph's team id); channel ids
 * look like "19:…@thread.tacv2" and never contain "|".
 */

export type TeamsThreadRef = {
  teamId: string;
  channelId: string;
  rootMessageId: string;
  /** The message that mentioned the bot (the root post itself, or a reply). */
  messageId: string;
};

export const TEAMS_INVALID_CHANNEL_ERROR =
  'Enter a channel link (in Teams: ••• next to the channel > "Get link to channel") or a channel id such as 19:abc…@thread.tacv2.';

const SEPARATOR = "|";
const KEY_PREFIX = "teams-";
const KEY_HASH_LENGTH = 10;
const MESSAGE_ID_MARKER = ";messageid=";
const CHANNEL_ID_RE = /^19:[^\s/?#;|]+@thread\.[a-z0-9]+$/i;
const MESSAGE_ID_RE = /^[\w-]{1,64}$/;
const TEAMS_LINK_HOSTS = new Set([
  "teams.microsoft.com",
  "teams.cloud.microsoft",
]);
const LINK_KINDS = new Set(["channel", "message"]);

export function encodeThreadExternalId(ref: TeamsThreadRef): string {
  return [ref.teamId, ref.channelId, ref.rootMessageId, ref.messageId].join(
    SEPARATOR
  );
}

export function decodeThreadExternalId(
  externalId: string
): TeamsThreadRef | null {
  const parts = externalId.split(SEPARATOR);
  if (parts.length !== 4) {
    return null;
  }
  const [teamId = "", channelId = "", rootMessageId = "", messageId = ""] =
    parts;
  if (
    !(
      CHANNEL_ID_RE.test(channelId) &&
      MESSAGE_ID_RE.test(rootMessageId) &&
      MESSAGE_ID_RE.test(messageId)
    )
  ) {
    return null;
  }
  return { teamId, channelId, rootMessageId, messageId };
}

/** Key of a thread ("teams-1a2b3c4d5e"): short, stable, safe in titles and branch names. */
export function teamsThreadKey(
  channelId: string,
  rootMessageId: string
): string {
  const hash = createHash("sha256")
    .update(`${channelId.toLowerCase()};${rootMessageId}`, "utf8")
    .digest("hex");
  return `${KEY_PREFIX}${hash.slice(0, KEY_HASH_LENGTH)}`;
}

/** The conversation id of a thread, as the Bot Connector addresses replies to it. */
export function threadConversationId(
  channelId: string,
  rootMessageId: string
): string {
  return `${channelId}${MESSAGE_ID_MARKER}${rootMessageId}`;
}

/** The root message id of a thread conversation id; null for a bare channel id. */
export function rootMessageIdOf(conversationId: string): string | null {
  const marker = conversationId.toLowerCase().indexOf(MESSAGE_ID_MARKER);
  if (marker < 0) {
    return null;
  }
  const id = conversationId.slice(marker + MESSAGE_ID_MARKER.length).trim();
  return MESSAGE_ID_RE.test(id) ? id : null;
}

export function isTeamsMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value);
}

/** Deep link to a message of a channel thread. */
export function teamsMessageLink(
  ref: TeamsThreadRef,
  tenantId: string | null
): string {
  const url = new URL(
    `https://teams.microsoft.com/l/message/${encodeURIComponent(ref.channelId)}/${encodeURIComponent(ref.messageId)}`
  );
  if (tenantId) {
    url.searchParams.set("tenantId", tenantId);
  }
  if (ref.teamId) {
    url.searchParams.set("groupId", ref.teamId);
  }
  url.searchParams.set("parentMessageId", ref.rootMessageId);
  return url.toString();
}

/**
 * A channel id from what an admin pastes: the id itself, or a Teams link to
 * the channel or to one of its messages. Lower-cased, like the scopes
 * project connections claim.
 */
export function parseChannelReference(input: string): Result<string, string> {
  const trimmed = input.trim();
  if (CHANNEL_ID_RE.test(trimmed)) {
    return Result.ok(trimmed.toLowerCase());
  }
  const url = URL.parse(trimmed);
  if (!(url && TEAMS_LINK_HOSTS.has(url.hostname.toLowerCase()))) {
    return Result.err(TEAMS_INVALID_CHANNEL_ERROR);
  }
  // /l/channel/{channelId}/{name} or /l/message/{channelId}/{messageId}
  const [, prefix, kind, encoded] = url.pathname.split("/");
  if (!(prefix === "l" && kind && LINK_KINDS.has(kind) && encoded)) {
    return Result.err(TEAMS_INVALID_CHANNEL_ERROR);
  }
  const channelId = safeDecode(encoded);
  return CHANNEL_ID_RE.test(channelId)
    ? Result.ok(channelId.toLowerCase())
    : Result.err(TEAMS_INVALID_CHANNEL_ERROR);
}

/** A channel id (or link) as claims and filters compare it; the input when it is neither. */
export function normalizeChannelReference(input: string): string {
  const parsed = parseChannelReference(input);
  return parsed.ok ? parsed.value : input.trim().toLowerCase();
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
