import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { HttpMethod, type ProviderHttp } from "../../types";
import type { TeamsThreadRef } from "./thread-ref";

/**
 * Reading channel threads through Microsoft Graph with the bot's app-only
 * token. The Teams app grants it the resource-specific consent permission
 * ChannelMessage.Read.Group in each team it is installed in, so no tenant-
 * wide (protected) Graph permission is needed.
 */

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Replies read per thread (newest kept); Graph pages hold at most 50. */
export const GRAPH_REPLIES_MAX = 500;

export const GraphErrorKind = {
  Forbidden: "forbidden",
  NotFound: "not_found",
  Other: "other",
} as const;
export type GraphErrorKind =
  (typeof GraphErrorKind)[keyof typeof GraphErrorKind];

export type GraphError = {
  kind: GraphErrorKind;
  status: number;
  retryable: boolean;
  message: string;
};

const GRAPH_TIMEOUT_MS = 20_000;
const REPLIES_PAGE_SIZE = 50;

const identitySchema = z
  .looseObject({
    id: z.string().nullish(),
    displayName: z.string().nullish(),
  })
  .nullish();

export const graphMessageSchema = z.looseObject({
  id: z.string().min(1),
  replyToId: z.string().nullish(),
  messageType: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  deletedDateTime: z.string().nullish(),
  subject: z.string().nullish(),
  webUrl: z.string().nullish(),
  body: z
    .looseObject({
      contentType: z.string().nullish(),
      content: z.string().nullish(),
    })
    .nullish(),
  from: z
    .looseObject({ user: identitySchema, application: identitySchema })
    .nullish(),
  attachments: z
    .array(
      z.looseObject({
        id: z.string().nullish(),
        contentType: z.string().nullish(),
        contentUrl: z.string().nullish(),
        content: z.string().nullish(),
        name: z.string().nullish(),
      })
    )
    .nullish(),
  mentions: z
    .array(
      z.looseObject({
        id: z.number().int(),
        mentionText: z.string().nullish(),
        mentioned: z
          .looseObject({ user: identitySchema, application: identitySchema })
          .nullish(),
      })
    )
    .nullish(),
});
export type GraphMessage = z.infer<typeof graphMessageSchema>;

const repliesPageSchema = z.object({
  value: z.array(z.unknown()),
  "@odata.nextLink": z.string().nullish(),
});

/** The thread's root post. */
export function getRootMessage(
  http: ProviderHttp,
  token: string,
  ref: TeamsThreadRef
): Promise<Result<GraphMessage, GraphError>> {
  return getMessage(http, token, messagePath(ref));
}

/** One reply of the thread. */
export function getReply(
  http: ProviderHttp,
  token: string,
  ref: TeamsThreadRef,
  replyId: string
): Promise<Result<GraphMessage, GraphError>> {
  return getMessage(
    http,
    token,
    `${messagePath(ref)}/replies/${encodeURIComponent(replyId)}`
  );
}

/**
 * The thread's replies, following Graph's pages up to GRAPH_REPLIES_MAX.
 * `truncated` says replies were left out.
 */
export async function listReplies(
  http: ProviderHttp,
  token: string,
  ref: TeamsThreadRef
): Promise<
  Result<{ replies: GraphMessage[]; truncated: boolean }, GraphError>
> {
  const replies: GraphMessage[] = [];
  let url: string | null =
    `${GRAPH_BASE_URL}${messagePath(ref)}/replies?$top=${REPLIES_PAGE_SIZE}`;
  while (url && replies.length < GRAPH_REPLIES_MAX) {
    const response = await http.request({
      method: HttpMethod.Get,
      url,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: GRAPH_TIMEOUT_MS,
    });
    const page = repliesPageSchema.safeParse(response.json);
    if (!(response.ok && page.success)) {
      return Result.err(graphError(response.status, response.retryable));
    }
    for (const candidate of page.data.value) {
      const message = graphMessageSchema.safeParse(candidate);
      if (message.success) {
        replies.push(message.data);
      }
    }
    url = nextPageUrl(page.data["@odata.nextLink"]);
  }
  return Result.ok({
    replies: replies.slice(0, GRAPH_REPLIES_MAX),
    truncated: url !== null,
  });
}

async function getMessage(
  http: ProviderHttp,
  token: string,
  path: string
): Promise<Result<GraphMessage, GraphError>> {
  const response = await http.request({
    method: HttpMethod.Get,
    url: `${GRAPH_BASE_URL}${path}`,
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: GRAPH_TIMEOUT_MS,
  });
  const message = graphMessageSchema.safeParse(response.json);
  if (response.ok && message.success) {
    return Result.ok(message.data);
  }
  return Result.err(graphError(response.status, response.retryable));
}

function messagePath(ref: TeamsThreadRef): string {
  return `/teams/${encodeURIComponent(ref.teamId)}/channels/${encodeURIComponent(ref.channelId)}/messages/${encodeURIComponent(ref.rootMessageId)}`;
}

/** Only Graph's own next links are followed (the token goes with them). */
function nextPageUrl(link: string | null | undefined): string | null {
  if (!link?.startsWith(`${GRAPH_BASE_URL}/`)) {
    return null;
  }
  return link;
}

function graphError(status: number, retryable: boolean): GraphError {
  if (status === 401 || status === 403) {
    return {
      kind: GraphErrorKind.Forbidden,
      status,
      retryable: false,
      message: `Microsoft Graph refused to read the thread (HTTP ${status}). The Teams app must declare the resource-specific permission ChannelMessage.Read.Group and be installed in the team; reinstall it after changing the manifest.`,
    };
  }
  if (status === 404) {
    return {
      kind: GraphErrorKind.NotFound,
      status,
      retryable: false,
      message:
        "The thread was not found in Microsoft Graph: it was deleted, or the Teams app is not installed in its team.",
    };
  }
  if (status === 0) {
    return {
      kind: GraphErrorKind.Other,
      status,
      retryable: true,
      message: "Could not reach Microsoft Graph (network error or timeout).",
    };
  }
  return {
    kind: GraphErrorKind.Other,
    status,
    retryable,
    message: `Microsoft Graph could not read the thread (HTTP ${status}).`,
  };
}
