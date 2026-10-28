import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import type {
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../../types";
import {
  AtlassianProduct,
  atlassianBasicAuthorization,
  atlassianGatewayUrl,
} from "../atlassian/auth";
import {
  type ConfluenceConnectionConfig,
  type ConfluenceSecrets,
  confluenceErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the Confluence Cloud REST API for one connection:
 * the bot account's email and API token (Basic auth), against the site or,
 * for a token with scopes, the Atlassian API gateway. Every call returns a
 * Result whose error message never contains the token; `retryable` follows
 * ProviderHttpResponse (timeouts, network errors, 429, 5xx).
 */

export type ConfluenceContext = ProviderContext<
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>;

export const ConfluenceErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  /** The page changed since it was read (version conflict). */
  Conflict: "conflict",
  BadRequest: "bad_request",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type ConfluenceErrorKind =
  (typeof ConfluenceErrorKind)[keyof typeof ConfluenceErrorKind];

export type ConfluenceError = {
  kind: ConfluenceErrorKind;
  status: number;
  /** User-facing; includes Confluence's message when there is one. */
  message: string;
  retryable: boolean;
};

export type ConfluenceRequest = {
  method: ProviderHttpRequest["method"];
  /** Path below `/wiki/` (`api/v2/pages/1`), segments already encoded. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: JsonValue;
};

export const CONFLUENCE_CREDENTIALS_REJECTED =
  "Confluence rejected the credentials (HTTP 401). Check the bot account's email address and API token. An API token with scopes also needs the read:confluence-user, read:page:confluence, write:page:confluence, read:comment:confluence, write:comment:confluence, read:space:confluence and search:confluence scopes.";
const CONFLUENCE_UNEXPECTED_RESPONSE =
  "Confluence returned an unexpected response. Check the site URL.";

export async function confluenceRequest<T>(
  ctx: ConfluenceContext,
  request: ConfluenceRequest,
  schema: z.ZodType<T>
): Promise<Result<T, ConfluenceError>> {
  const response = await ctx.http.request({
    method: request.method,
    url: buildConfluenceUrl(ctx.connection.config, request.path, request.query),
    headers: {
      authorization: atlassianBasicAuthorization(
        ctx.connection.config.email,
        ctx.connection.secrets.apiToken
      ),
    },
    body: request.body,
  });
  const failure = classifyFailure(response);
  if (failure) {
    return Result.err(failure);
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return Result.err({
      kind: ConfluenceErrorKind.InvalidResponse,
      status: response.status,
      message: CONFLUENCE_UNEXPECTED_RESPONSE,
      retryable: false,
    });
  }
  return Result.ok(parsed.data);
}

/** `{site}/wiki`, or the API gateway's `…/ex/confluence/{cloudId}/wiki`. */
export function confluenceBaseUrl(config: ConfluenceConnectionConfig): string {
  return config.cloudId
    ? `${atlassianGatewayUrl(AtlassianProduct.Confluence, config.cloudId)}/wiki`
    : `${config.siteUrl}/wiki`;
}

export function buildConfluenceUrl(
  config: ConfluenceConnectionConfig,
  path: string,
  query: ConfluenceRequest["query"]
): string {
  const [pathname, inline] = path.split("?", 2);
  const search = new URLSearchParams(inline ?? "");
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  const base = `${confluenceBaseUrl(config)}/${pathname}`;
  return encoded ? `${base}?${encoded}` : base;
}

/**
 * The path of a v2 `_links.next` (`/wiki/api/v2/…?cursor=…`) below `/wiki/`;
 * null for anything else, so a link never leads off the API.
 */
export function nextPagePath(next: string | null | undefined): string | null {
  if (!next?.startsWith(NEXT_PREFIX) || next.includes("..")) {
    return null;
  }
  return next.slice(WIKI_PREFIX.length);
}

/** Browser URL of a `_links.webui` path. */
export function confluenceWebUrl(
  config: ConfluenceConnectionConfig,
  webui: string | null | undefined
): string | null {
  return webui ? `${config.siteUrl}/wiki${webui}` : null;
}

const WIKI_PREFIX = "/wiki/";
const NEXT_PREFIX = "/wiki/api/v2/";
const ERROR_DETAIL_MAX = 300;
const WHITESPACE_RE = /\s+/g;

function classifyFailure(
  response: ProviderHttpResponse
): ConfluenceError | null {
  if (response.status === 0) {
    return {
      kind: ConfluenceErrorKind.Unavailable,
      status: 0,
      message: `Could not reach Confluence (${response.error ?? "network error"})`,
      retryable: response.retryable,
    };
  }
  if (response.ok) {
    return null;
  }
  const status = response.status;
  const detail = readErrorMessage(response.json);
  const error = (
    kind: ConfluenceErrorKind,
    message: string,
    retryable = false
  ): ConfluenceError => ({
    kind,
    status,
    message: detail ? `${message}: ${detail}` : message,
    retryable,
  });
  switch (status) {
    case 401:
      return {
        kind: ConfluenceErrorKind.Unauthorized,
        status,
        message: CONFLUENCE_CREDENTIALS_REJECTED,
        retryable: false,
      };
    case 403:
      return error(
        ConfluenceErrorKind.Forbidden,
        "Confluence denied access (HTTP 403); check the bot account's space permissions"
      );
    case 404:
      return error(
        ConfluenceErrorKind.NotFound,
        "Not found in Confluence (HTTP 404)"
      );
    case 409:
      return error(
        ConfluenceErrorKind.Conflict,
        "Confluence refused the change because the page changed (HTTP 409)"
      );
    default:
      return response.retryable
        ? error(
            ConfluenceErrorKind.Unavailable,
            `Confluence is unavailable (HTTP ${status})`,
            true
          )
        : error(
            ConfluenceErrorKind.BadRequest,
            `Confluence rejected the request (HTTP ${status})`
          );
  }
}

function readErrorMessage(json: unknown): string | null {
  const parsed = confluenceErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const parts = [
    parsed.data.message ?? "",
    ...(parsed.data.errors ?? []).map(
      (entry) => entry.detail ?? entry.title ?? ""
    ),
  ];
  const message = parts
    .map((part) => part.replaceAll(WHITESPACE_RE, " ").trim())
    .filter((part) => part.length > 0)
    .join("; ");
  if (!message) {
    return null;
  }
  return message.length > ERROR_DETAIL_MAX
    ? `${message.slice(0, ERROR_DETAIL_MAX - 1)}…`
    : message;
}
