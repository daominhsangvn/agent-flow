import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import type {
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResponse,
  RepositoryInfo,
  RepositoryOperationResult,
} from "../../types";
import {
  type BitbucketConnectionConfig,
  type BitbucketSecrets,
  bitbucketErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the Bitbucket Cloud REST API (2.0) for one
 * connection. The token (an Atlassian API token with scopes, or a workspace,
 * project or repository access token) is sent as a bearer token. Every call
 * returns a Result: expected failures are values with a user-facing message
 * that never contains the token.
 */

export const BITBUCKET_TOKEN_REJECTED_MESSAGE =
  "Bitbucket rejected the API token";

export type BitbucketContext = ProviderContext<
  BitbucketConnectionConfig,
  BitbucketSecrets
>;

export const BitbucketErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Validation: "validation",
  RateLimited: "rate_limited",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type BitbucketErrorKind =
  (typeof BitbucketErrorKind)[keyof typeof BitbucketErrorKind];

export type BitbucketError = {
  kind: BitbucketErrorKind;
  status: number;
  /** User-facing; includes Bitbucket's message when there is one. */
  message: string;
  retryable: boolean;
};

export type BitbucketQueryValue = string | number | boolean | undefined;

export type BitbucketRequest = {
  method: ProviderHttpRequest["method"];
  /**
   * Path below the API URL with a leading slash and segments already
   * encoded, or a `next` link of a previous page (absolute, below the API URL).
   */
  path: string;
  query?: Record<string, BitbucketQueryValue>;
  body?: JsonValue;
};

export async function bitbucketRequest<T>(
  ctx: BitbucketContext,
  request: BitbucketRequest,
  schema: z.ZodType<T>
): Promise<Result<T, BitbucketError>> {
  const url = buildBitbucketUrl(ctx.connection.config.apiUrl, request);
  if (!url) {
    return Result.err({
      kind: BitbucketErrorKind.InvalidResponse,
      status: 0,
      message: "Bitbucket returned a link outside its API",
      retryable: false,
    });
  }
  const response = await ctx.http.request({
    method: request.method,
    url,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${ctx.connection.secrets.token}`,
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
      kind: BitbucketErrorKind.InvalidResponse,
      status: response.status,
      message: "Bitbucket returned an unexpected response",
      retryable: false,
    });
  }
  return Result.ok(parsed.data);
}

/** Encodes one path segment (workspace, repository slug or UUID). */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Quotes a value for a Bitbucket query (`q=name ~ "..."`): backslashes and
 * double quotes are escaped.
 */
export function bbqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Null when an absolute `next` link points outside the API URL. */
function buildBitbucketUrl(
  apiUrl: string,
  request: BitbucketRequest
): string | null {
  const absolute = request.path.startsWith("http");
  if (absolute && !request.path.startsWith(`${apiUrl}/`)) {
    return null;
  }
  const base = absolute ? request.path : `${apiUrl}${request.path}`;
  const search = Object.entries(request.query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
  if (!search) {
    return base;
  }
  return `${base}${base.includes("?") ? "&" : "?"}${search}`;
}

const BITBUCKET_ERROR_DETAIL_MAX = 300;

function classifyFailure(response: ProviderHttpResponse): BitbucketError {
  if (response.status === 0) {
    return {
      kind: BitbucketErrorKind.Unavailable,
      status: 0,
      message: `Could not reach Bitbucket (${response.error ?? "network error"})`,
      retryable: response.retryable,
    };
  }
  const detail = readBitbucketErrorMessage(response.json);
  if (response.status === 401) {
    return {
      kind: BitbucketErrorKind.Unauthorized,
      status: 401,
      message: BITBUCKET_TOKEN_REJECTED_MESSAGE,
      retryable: false,
    };
  }
  if (response.status === 429) {
    return {
      kind: BitbucketErrorKind.RateLimited,
      status: 429,
      message: withDetail("Bitbucket rate limit reached", detail),
      retryable: true,
    };
  }
  return classifyErrorStatus(response, detail);
}

function classifyErrorStatus(
  response: ProviderHttpResponse,
  detail: string | null
): BitbucketError {
  if (response.status === 403) {
    return {
      kind: BitbucketErrorKind.Forbidden,
      status: 403,
      message: withDetail(
        "Bitbucket denied access; check the token's scopes (repositories and pull requests: read and write)",
        detail
      ),
      retryable: false,
    };
  }
  if (response.status === 404) {
    return {
      kind: BitbucketErrorKind.NotFound,
      status: 404,
      message: withDetail(
        "Not found on Bitbucket, or the token cannot access it",
        detail
      ),
      retryable: false,
    };
  }
  if (response.status === 400) {
    return {
      kind: BitbucketErrorKind.Validation,
      status: 400,
      message: withDetail("Bitbucket rejected the request", detail),
      retryable: false,
    };
  }
  return {
    kind: response.retryable
      ? BitbucketErrorKind.Unavailable
      : BitbucketErrorKind.InvalidResponse,
    status: response.status,
    message: withDetail(
      response.retryable
        ? `Bitbucket is unavailable (HTTP ${response.status})`
        : `Bitbucket rejected the request (HTTP ${response.status})`,
      detail
    ),
    retryable: response.retryable,
  };
}

/** Bitbucket's `error.message` plus a string `error.detail` when there is one. */
function readBitbucketErrorMessage(json: unknown): string | null {
  const parsed = bitbucketErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const { message, detail } = parsed.data.error;
  const text = [message, typeof detail === "string" ? detail : null]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(": ")
    .trim();
  if (!text) {
    return null;
  }
  return text.length > BITBUCKET_ERROR_DETAIL_MAX
    ? `${text.slice(0, BITBUCKET_ERROR_DETAIL_MAX - 1)}…`
    : text;
}

function withDetail(message: string, detail: string | null): string {
  return detail ? `${message}: ${detail}` : message;
}

/** `/repositories/{workspace}/{repository slug}`. */
export function repositoryPath(repository: RepositoryInfo): string {
  return `/repositories/${pathSegment(repository.namespace)}/${pathSegment(repository.name)}`;
}

export function operationOk<T>(value: T): RepositoryOperationResult<T> {
  return { ok: true, value };
}

export function operationError<T>(
  error: BitbucketError
): RepositoryOperationResult<T> {
  return { ok: false, error: error.message, retryable: error.retryable };
}
