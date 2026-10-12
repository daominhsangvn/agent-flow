import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import type {
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../../types";
import {
  type LocalGitConnectionConfig,
  type LocalGitSecrets,
  localGitErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the Local Git (Gitea) REST API v1 for one
 * connection, with the connection's access token. Every call returns a
 * Result: expected failures are values with a user-facing message that never
 * contains the token.
 */

export const LOCAL_GIT_TOKEN_REJECTED_MESSAGE =
  "Local Git rejected the access token";

export type LocalGitContext = ProviderContext<
  LocalGitConnectionConfig,
  LocalGitSecrets
>;

export const LocalGitErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  Validation: "validation",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type LocalGitErrorKind =
  (typeof LocalGitErrorKind)[keyof typeof LocalGitErrorKind];

export type LocalGitError = {
  kind: LocalGitErrorKind;
  status: number;
  /** User-facing; includes Local Git's message when there is one. */
  message: string;
  retryable: boolean;
};

export type LocalGitQueryValue = string | number | boolean | undefined;

export type LocalGitRequest = {
  method: ProviderHttpRequest["method"];
  /** Path below /api/v1 with a leading slash and segments already encoded. */
  path: string;
  query?: Record<string, LocalGitQueryValue>;
  body?: JsonValue;
};

export async function localGitRequest<T>(
  ctx: LocalGitContext,
  request: LocalGitRequest,
  schema: z.ZodType<T>
): Promise<Result<T, LocalGitError>> {
  const response = await ctx.http.request({
    method: request.method,
    url: buildApiUrl(ctx.connection.config.serverUrl, request),
    headers: {
      accept: "application/json",
      authorization: `token ${ctx.connection.secrets.token}`,
      "user-agent": "AgentFlow",
    },
    body: request.body,
    // The token must never follow a redirect to another host.
    followRedirects: false,
  });
  if (!response.ok) {
    return Result.err(classifyFailure(response));
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return Result.err({
      kind: LocalGitErrorKind.InvalidResponse,
      status: response.status,
      message: "Local Git returned an unexpected response",
      retryable: false,
    });
  }
  return Result.ok(parsed.data);
}

/** Encodes one path segment (owner, repository or branch name). */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildApiUrl(serverUrl: string, request: LocalGitRequest): string {
  const base = `${serverUrl}/api/v1${request.path}`;
  const search = Object.entries(request.query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
  return search ? `${base}?${search}` : base;
}

const LOCAL_GIT_ERROR_DETAIL_MAX = 300;

function classifyFailure(response: ProviderHttpResponse): LocalGitError {
  if (response.status === 0) {
    return {
      kind: LocalGitErrorKind.Unavailable,
      status: 0,
      message: `Could not reach Local Git (${response.error ?? "network error"}). Is it running (docker compose up -d local-git)?`,
      retryable: response.retryable,
    };
  }
  const detail = readLocalGitErrorMessage(response.json);
  if (response.status === 401) {
    return {
      kind: LocalGitErrorKind.Unauthorized,
      status: 401,
      message: LOCAL_GIT_TOKEN_REJECTED_MESSAGE,
      retryable: false,
    };
  }
  const known = KNOWN_FAILURES.get(response.status);
  if (known) {
    return {
      kind: known.kind,
      status: response.status,
      message: withDetail(known.message, detail),
      retryable: false,
    };
  }
  return {
    kind: response.retryable
      ? LocalGitErrorKind.Unavailable
      : LocalGitErrorKind.InvalidResponse,
    status: response.status,
    message: withDetail(
      response.retryable
        ? `Local Git is unavailable (HTTP ${response.status})`
        : `Local Git rejected the request (HTTP ${response.status})`,
      detail
    ),
    retryable: response.retryable,
  };
}

const KNOWN_FAILURES = new Map<
  number,
  { kind: LocalGitErrorKind; message: string }
>([
  [
    403,
    {
      kind: LocalGitErrorKind.Forbidden,
      message:
        "Local Git denied access; the token needs the scopes write:repository, write:organization, write:user and write:issue",
    },
  ],
  [
    404,
    {
      kind: LocalGitErrorKind.NotFound,
      message: "Not found on Local Git, or the token cannot access it",
    },
  ],
  [
    409,
    { kind: LocalGitErrorKind.Conflict, message: "Local Git: already exists" },
  ],
  [
    422,
    {
      kind: LocalGitErrorKind.Validation,
      message: "Local Git rejected the request",
    },
  ],
]);

function readLocalGitErrorMessage(json: unknown): string | null {
  const parsed = localGitErrorBodySchema.safeParse(json);
  const text = parsed.success ? (parsed.data.message?.trim() ?? "") : "";
  if (!text) {
    return null;
  }
  return text.length > LOCAL_GIT_ERROR_DETAIL_MAX
    ? `${text.slice(0, LOCAL_GIT_ERROR_DETAIL_MAX - 1)}…`
    : text;
}

function withDetail(message: string, detail: string | null): string {
  return detail ? `${message}: ${detail}` : message;
}
