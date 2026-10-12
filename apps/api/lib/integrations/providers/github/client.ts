import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import type {
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../../types";
import {
  type GitHubConnectionConfig,
  type GitHubSecrets,
  githubErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the GitHub REST API for one connection. Every call
 * returns a Result: expected failures are values with a user-facing message
 * that never contains the token.
 */

export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_TOKEN_REJECTED_MESSAGE =
  "GitHub rejected the personal access token";

export type GitHubContext = ProviderContext<
  GitHubConnectionConfig,
  GitHubSecrets
>;

export const GitHubErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Validation: "validation",
  RateLimited: "rate_limited",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type GitHubErrorKind =
  (typeof GitHubErrorKind)[keyof typeof GitHubErrorKind];

export type GitHubError = {
  kind: GitHubErrorKind;
  status: number;
  /** User-facing; includes GitHub's message when there is one. */
  message: string;
  retryable: boolean;
};

export type GitHubQueryValue = string | number | boolean | undefined;

export type GitHubRequest = {
  method: ProviderHttpRequest["method"];
  /** Path below the API URL with a leading slash and segments already encoded. */
  path: string;
  query?: Record<string, GitHubQueryValue>;
  body?: JsonValue;
};

export async function githubRequest<T>(
  ctx: GitHubContext,
  request: GitHubRequest,
  schema: z.ZodType<T>
): Promise<Result<T, GitHubError>> {
  const response = await ctx.http.request({
    method: request.method,
    url: buildGitHubUrl(ctx.connection.config.apiUrl, request),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${ctx.connection.secrets.token}`,
      "user-agent": "AgentFlow",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    body: request.body,
  });
  if (!response.ok) {
    return Result.err(classifyFailure(response));
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return Result.err({
      kind: GitHubErrorKind.InvalidResponse,
      status: response.status,
      message: "GitHub returned an unexpected response",
      retryable: false,
    });
  }
  return Result.ok(parsed.data);
}

/** Encodes one path segment (owner, repository or branch name). */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildGitHubUrl(apiUrl: string, request: GitHubRequest): string {
  const search = Object.entries(request.query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
  const base = `${apiUrl}${request.path}`;
  return search ? `${base}?${search}` : base;
}

const GITHUB_ERROR_DETAIL_MAX = 300;

function classifyFailure(response: ProviderHttpResponse): GitHubError {
  if (response.status === 0) {
    return {
      kind: GitHubErrorKind.Unavailable,
      status: 0,
      message: `Could not reach GitHub (${response.error ?? "network error"})`,
      retryable: response.retryable,
    };
  }
  const detail = readGitHubErrorMessage(response.json);
  if (response.status === 401) {
    return {
      kind: GitHubErrorKind.Unauthorized,
      status: 401,
      message: GITHUB_TOKEN_REJECTED_MESSAGE,
      retryable: false,
    };
  }
  if (isRateLimited(response)) {
    return {
      kind: GitHubErrorKind.RateLimited,
      status: response.status,
      message: withDetail("GitHub rate limit reached", detail),
      retryable: true,
    };
  }
  return classifyErrorStatus(response, detail);
}

function classifyErrorStatus(
  response: ProviderHttpResponse,
  detail: string | null
): GitHubError {
  if (response.status === 403) {
    return {
      kind: GitHubErrorKind.Forbidden,
      status: 403,
      message: withDetail(
        "GitHub denied access; check the token's repository access and permissions (Contents and Pull requests: Read and write)",
        detail
      ),
      retryable: false,
    };
  }
  if (response.status === 404) {
    return {
      kind: GitHubErrorKind.NotFound,
      status: 404,
      message: withDetail(
        "Not found on GitHub, or the token cannot access it",
        detail
      ),
      retryable: false,
    };
  }
  if (response.status === 422) {
    return {
      kind: GitHubErrorKind.Validation,
      status: 422,
      message: withDetail("GitHub rejected the request", detail),
      retryable: false,
    };
  }
  return {
    kind: response.retryable
      ? GitHubErrorKind.Unavailable
      : GitHubErrorKind.InvalidResponse,
    status: response.status,
    message: withDetail(
      response.retryable
        ? `GitHub is unavailable (HTTP ${response.status})`
        : `GitHub rejected the request (HTTP ${response.status})`,
      detail
    ),
    retryable: response.retryable,
  };
}

/** Primary (remaining = 0) and secondary (retry-after) rate limits. */
function isRateLimited(response: ProviderHttpResponse): boolean {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }
  return (
    response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  );
}

/** GitHub's message plus the first validation error, e.g. "Validation Failed: No commits between main and feat". */
function readGitHubErrorMessage(json: unknown): string | null {
  const parsed = githubErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const first = parsed.data.errors?.find((error) => error.message)?.message;
  const message = [parsed.data.message, first]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(": ")
    .trim();
  if (!message) {
    return null;
  }
  return message.length > GITHUB_ERROR_DETAIL_MAX
    ? `${message.slice(0, GITHUB_ERROR_DETAIL_MAX - 1)}…`
    : message;
}

function withDetail(message: string, detail: string | null): string {
  return detail ? `${message}: ${detail}` : message;
}
