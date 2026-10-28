import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { truncateText } from "../../markdown";
import {
  RetryableSourceError,
  type SourceItem,
  type SourceItemAttachment,
  type SourceItemRef,
} from "../../types";
import { readBotCredentials, type TeamsProviderContext } from "./connection";
import { acquireEntraToken, GRAPH_SCOPE } from "./entra-token";
import {
  type GraphError,
  type GraphMessage,
  getReply,
  getRootMessage,
  listReplies,
} from "./graph-client";
import { firstLine, graphMessageMarkdown, messageAuthor } from "./message-text";
import {
  decodeThreadExternalId,
  type TeamsThreadRef,
  teamsMessageLink,
} from "./thread-ref";

/**
 * Source side of the Teams bot: the run's item is the channel thread the
 * bot was mentioned in, read through Microsoft Graph when the run imports it
 * (so edits made meanwhile are seen).
 *
 * - Description: the message that mentioned the bot, without the mention:
 *   the request the run carries out.
 * - Section "Teams thread": every message of the thread, oldest first, the
 *   root post first; the whole conversation is context. When it is too long
 *   the oldest replies are left out (the root post and the request stay).
 * - Reporter: who mentioned the bot.
 *
 * Temporary Graph failures (429, 5xx, timeouts) throw RetryableSourceError;
 * a missing permission or a deleted thread throws a plain Error.
 */

export const TEAMS_THREAD_SECTION_TITLE = "Teams thread";
export const TEAMS_ITEM_TYPE = "Teams message";
/** Characters of the thread transcript (the Issue document holds 100 000). */
export const TEAMS_TRANSCRIPT_MAX_LENGTH = 60_000;

const TITLE_MAX_LENGTH = 200;
const ATTACHMENTS_MAX = 50;
const REFERENCE_ATTACHMENT_TYPE = "reference";
const SYSTEM_MESSAGE_TYPES = new Set([
  "systemEventMessage",
  "unknownFutureValue",
]);

export async function fetchTeamsThread(
  ctx: TeamsProviderContext,
  item: SourceItemRef
): Promise<SourceItem> {
  const ref = decodeThreadExternalId(item.externalId);
  if (!ref) {
    throw new Error(`${item.key} is not a Teams channel thread.`);
  }
  if (!ref.teamId) {
    throw new Error(
      "The team of this channel is unknown, so the thread cannot be read. Check that the Teams app is installed in the team, then mention the bot again."
    );
  }
  const bot = readBotCredentials(ctx.connection);
  if (!(bot.ok && bot.value)) {
    throw new Error(
      "The Teams connection has no bot: enter its App ID, tenant ID and client secret."
    );
  }
  const token = await acquireEntraToken(
    ctx.http,
    bot.value,
    GRAPH_SCOPE,
    ctx.now()
  );
  if (!token.ok) {
    throw sourceFailure(token.error.message, token.error.retryable);
  }
  const thread = await readThread(ctx, token.value, ref);
  if (!thread.ok) {
    throw sourceFailure(thread.error.message, thread.error.retryable);
  }
  return toSourceItem(item, ref, thread.value, {
    appId: bot.value.appId,
    tenantId: bot.value.tenantId,
  });
}

type Thread = {
  root: GraphMessage;
  /** Oldest first, without deleted and system messages. */
  replies: GraphMessage[];
  request: GraphMessage;
  /** Replies Graph had beyond the ones read. */
  truncated: boolean;
};

async function readThread(
  ctx: TeamsProviderContext,
  token: string,
  ref: TeamsThreadRef
): Promise<Result<Thread, GraphError>> {
  const root = await getRootMessage(ctx.http, token, ref);
  if (!root.ok) {
    return root;
  }
  const listed = await listReplies(ctx.http, token, ref);
  if (!listed.ok) {
    return listed;
  }
  const replies = listed.value.replies
    .filter(isConversationMessage)
    .sort(byCreatedTime);
  if (ref.messageId === ref.rootMessageId) {
    return Result.ok({
      root: root.value,
      replies,
      request: root.value,
      truncated: listed.value.truncated,
    });
  }
  const listedRequest = replies.find((reply) => reply.id === ref.messageId);
  const request = listedRequest
    ? Result.ok<GraphMessage, GraphError>(listedRequest)
    : await getReply(ctx.http, token, ref, ref.messageId);
  if (!request.ok) {
    return request;
  }
  return Result.ok({
    root: root.value,
    replies,
    request: request.value,
    truncated: listed.value.truncated,
  });
}

function toSourceItem(
  item: SourceItemRef,
  ref: TeamsThreadRef,
  thread: Thread,
  bot: { appId: string; tenantId: string }
): SourceItem {
  const request = graphMessageMarkdown(thread.request, bot.appId);
  const subject = thread.root.subject?.trim() ?? "";
  const title = (firstLine(request) || subject || "Teams request").slice(
    0,
    TITLE_MAX_LENGTH
  );
  return {
    provider: IntegrationProviderKey.MicrosoftTeams,
    externalId: item.externalId,
    key: item.key,
    url: thread.request.webUrl ?? teamsMessageLink(ref, bot.tenantId),
    title,
    container: ref.channelId,
    bodyMarkdown: request,
    itemType: TEAMS_ITEM_TYPE,
    status: null,
    priority: null,
    labels: [],
    reporter: messageAuthor(thread.request),
    assignee: null,
    sections: [
      {
        title: TEAMS_THREAD_SECTION_TITLE,
        markdown: transcript(thread, bot.appId),
      },
    ],
    comments: [],
    attachments: threadAttachments([thread.root, ...thread.replies]),
  };
}

/**
 * The thread as markdown, oldest first. Over the limit, the oldest replies
 * are dropped (the root post and the request stay) and a note says so.
 */
function transcript(thread: Thread, appId: string): string {
  const entry = (message: GraphMessage, note: string) => {
    const when = message.createdDateTime ? ` (${message.createdDateTime})` : "";
    const text = graphMessageMarkdown(message, appId) || "_(no text)_";
    return `**${messageAuthor(message)}**${when}${note}:\n\n${text}`;
  };
  const isRequest = (message: GraphMessage) => message.id === thread.request.id;
  const rootNote = isRequest(thread.root)
    ? " — started the thread with the request to the bot"
    : " — started the thread";
  const subject = thread.root.subject?.trim();
  const head = [
    subject ? `Subject: **${subject}**` : "",
    entry(thread.root, rootNote),
  ].filter((part) => part !== "");
  const replies = thread.replies.map((reply) =>
    entry(reply, isRequest(reply) ? " — the request to the bot" : "")
  );
  const budget = TEAMS_TRANSCRIPT_MAX_LENGTH - head.join("\n\n").length;
  const kept: string[] = [];
  let used = 0;
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const text = replies[index] ?? "";
    if (used + text.length + 2 > budget && kept.length > 0) {
      break;
    }
    kept.unshift(text);
    used += text.length + 2;
  }
  const omitted = replies.length - kept.length + (thread.truncated ? 1 : 0);
  const omittedNote =
    omitted > 0
      ? ["_Earlier replies are left out: the thread is too long._"]
      : [];
  return truncateText(
    [...head, ...omittedNote, ...kept].join("\n\n"),
    TEAMS_TRANSCRIPT_MAX_LENGTH
  );
}

/** Files shared in the thread (SharePoint references), at most ATTACHMENTS_MAX. */
function threadAttachments(messages: GraphMessage[]): SourceItemAttachment[] {
  const seen = new Set<string>();
  const attachments: SourceItemAttachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const url = attachment.contentUrl ?? null;
      if (
        attachment.contentType !== REFERENCE_ATTACHMENT_TYPE ||
        !url ||
        seen.has(url)
      ) {
        continue;
      }
      seen.add(url);
      attachments.push({
        name: attachment.name?.trim() || "attachment",
        url,
        mimeType: null,
        size: null,
      });
    }
  }
  return attachments.slice(0, ATTACHMENTS_MAX);
}

function isConversationMessage(message: GraphMessage): boolean {
  return !(
    message.deletedDateTime ||
    (message.messageType && SYSTEM_MESSAGE_TYPES.has(message.messageType))
  );
}

function byCreatedTime(left: GraphMessage, right: GraphMessage): number {
  return createdTime(left) - createdTime(right);
}

function createdTime(message: GraphMessage): number {
  const time = Date.parse(message.createdDateTime ?? "");
  return Number.isNaN(time) ? 0 : time;
}

/** RetryableSourceError for temporary failures, a plain Error otherwise (same message). */
function sourceFailure(message: string, retryable: boolean): Error {
  return retryable ? new RetryableSourceError(message) : new Error(message);
}
