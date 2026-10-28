import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import {
  HttpMethod,
  type ProviderContext,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
} from "../../types";
import { buildJiraAuthorization, jiraRestBaseUrl } from "./auth";
import { JiraDeployment } from "./constants";
import {
  type JiraConnectionConfig,
  type JiraSecrets,
  jiraErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the Jira REST API (v3 on Cloud, v2 on Data
 * Center) for one connection.
 *
 * Every call returns a Result: expected failures (bad credentials, missing
 * issue, permission, outage) are values with a user-facing message that
 * never contains the token. `retryable` follows ProviderHttpResponse
 * (timeouts, network errors, 408/425/429, 5xx).
 */

export type JiraContext = ProviderContext<JiraConnectionConfig, JiraSecrets>;

export const JiraErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  BadRequest: "bad_request",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type JiraErrorKind = (typeof JiraErrorKind)[keyof typeof JiraErrorKind];

export type JiraError = {
  kind: JiraErrorKind;
  status: number;
  /** User-facing; includes Jira's error message when there is one. */
  message: string;
  retryable: boolean;
};

export type JiraQueryValue = string | number | boolean | undefined;

export type JiraRequest = {
  method: ProviderHttpRequest["method"];
  /** Path below `/rest/api/{3|2}/`, without a leading slash, segments already encoded. */
  path: string;
  query?: Record<string, JiraQueryValue>;
  /** JSON, or FormData for a multipart upload. */
  body?: JsonValue | FormData;
  /** Sent besides the authorization header. */
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export const JIRA_CLOUD_CREDENTIALS_REJECTED =
  "Jira rejected the credentials (HTTP 401). Check the bot account's email address and API token. An API token with scopes also needs the read:jira-user, read:jira-work and write:jira-work scopes.";
export const JIRA_DATA_CENTER_CREDENTIALS_REJECTED =
  "Jira rejected the credentials (HTTP 401). Check the personal access token of the bot account.";
const JIRA_CAPTCHA_REQUIRED =
  "Jira denied access (HTTP 403) because the bot account must pass a CAPTCHA after failed sign-ins. Sign in once as the bot account in a browser, then try again.";
const JIRA_UNEXPECTED_RESPONSE =
  "Jira returned an unexpected response. Check the site URL and the deployment type.";

export async function jiraRequest<T>(
  ctx: JiraContext,
  request: JiraRequest,
  schema: z.ZodType<T>
): Promise<Result<T, JiraError>> {
  const response = await sendJiraRequest(ctx, request);
  const failure = classifyJiraFailure(
    response,
    ctx.connection.config.deployment
  );
  if (failure) {
    return Result.err(failure);
  }
  const parsed = schema.safeParse(response.json);
  if (response.json === undefined || !parsed.success) {
    return Result.err(unexpectedResponse(response.status));
  }
  return Result.ok(parsed.data);
}

/** For endpoints that answer 204 No Content (e.g. POST transitions). */
export async function jiraRequestWithoutBody(
  ctx: JiraContext,
  request: JiraRequest
): Promise<Result<null, JiraError>> {
  const response = await sendJiraRequest(ctx, request);
  const failure = classifyJiraFailure(
    response,
    ctx.connection.config.deployment
  );
  return failure ? Result.err(failure) : Result.ok(null);
}

/**
 * The body of an authenticated download as text (an attachment's content),
 * from an absolute URL of this connection (its REST base, or its site on Data
 * Center). Redirects are followed: Cloud answers with a signed media URL.
 */
export async function jiraDownloadText(
  ctx: JiraContext,
  url: string,
  timeoutMs?: number
): Promise<Result<string, JiraError>> {
  const { config, secrets } = ctx.connection;
  const response = await ctx.http.request({
    method: HttpMethod.Get,
    url,
    headers: {
      accept: "*/*",
      authorization: buildJiraAuthorization(config, secrets),
    },
    timeoutMs,
  });
  const failure = classifyJiraFailure(response, config.deployment);
  return failure ? Result.err(failure) : Result.ok(response.text);
}

export function buildJiraUrl(
  config: JiraConnectionConfig,
  path: string,
  query: Record<string, JiraQueryValue> | undefined
): string {
  const base = `${jiraRestBaseUrl(config)}/${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.append(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `${base}?${encoded}` : base;
}

/** `issue/{idOrKey}` or `issue/{idOrKey}/{suffix}`. */
export function jiraIssuePath(idOrKey: string, suffix?: string): string {
  const base = `issue/${encodeURIComponent(idOrKey)}`;
  return suffix ? `${base}/${suffix}` : base;
}

/** Browser URL of an issue. */
export function jiraIssueBrowseUrl(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`;
}

const JIRA_ERROR_DETAIL_MAX = 300;
const WHITESPACE_RE = /\s+/g;
const SERAPH_LOGIN_REASON_HEADER = "x-seraph-loginreason";
const CAPTCHA_LOGIN_REASON = "AUTHENTICATION_DENIED";

function sendJiraRequest(
  ctx: JiraContext,
  request: JiraRequest
): Promise<ProviderHttpResponse> {
  const { config, secrets } = ctx.connection;
  return ctx.http.request({
    method: request.method,
    url: buildJiraUrl(config, request.path, request.query),
    headers: {
      ...request.headers,
      authorization: buildJiraAuthorization(config, secrets),
    },
    body: request.body,
    timeoutMs: request.timeoutMs,
  });
}

function classifyJiraFailure(
  response: ProviderHttpResponse,
  deployment: JiraDeployment
): JiraError | null {
  if (response.status === 0) {
    return {
      kind: JiraErrorKind.Unavailable,
      status: 0,
      message: `Could not reach Jira (${response.error ?? "network error"})`,
      retryable: response.retryable,
    };
  }
  if (response.ok) {
    return null;
  }
  if (response.status === 401) {
    return {
      kind: JiraErrorKind.Unauthorized,
      status: 401,
      message:
        deployment === JiraDeployment.Cloud
          ? JIRA_CLOUD_CREDENTIALS_REJECTED
          : JIRA_DATA_CENTER_CREDENTIALS_REJECTED,
      retryable: false,
    };
  }
  return classifyErrorStatus(response);
}

function classifyErrorStatus(response: ProviderHttpResponse): JiraError {
  const detail = readJiraErrorMessage(response.json);
  const status = response.status;
  if (status === 403) {
    return {
      kind: JiraErrorKind.Forbidden,
      status,
      message: requiresCaptcha(response)
        ? JIRA_CAPTCHA_REQUIRED
        : withDetail(
            "Jira denied access (HTTP 403); check the bot account's project permissions",
            detail
          ),
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: JiraErrorKind.NotFound,
      status,
      message: withDetail("Not found in Jira (HTTP 404)", detail),
      retryable: false,
    };
  }
  if (response.retryable) {
    return {
      kind: JiraErrorKind.Unavailable,
      status,
      message: withDetail(`Jira is unavailable (HTTP ${status})`, detail),
      retryable: true,
    };
  }
  return {
    kind: JiraErrorKind.BadRequest,
    status,
    message: withDetail(`Jira rejected the request (HTTP ${status})`, detail),
    retryable: false,
  };
}

function requiresCaptcha(response: ProviderHttpResponse): boolean {
  const reason = response.headers.get(SERAPH_LOGIN_REASON_HEADER) ?? "";
  return reason.toUpperCase().includes(CAPTCHA_LOGIN_REASON);
}

function unexpectedResponse(status: number): JiraError {
  return {
    kind: JiraErrorKind.InvalidResponse,
    status,
    message: JIRA_UNEXPECTED_RESPONSE,
    retryable: false,
  };
}

function readJiraErrorMessage(json: unknown): string | null {
  const parsed = jiraErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const parts = [
    ...(parsed.data.errorMessages ?? []),
    ...Object.values(parsed.data.errors ?? {}),
    parsed.data.message ?? "",
  ];
  const message = parts
    .map((part) => part.replaceAll(WHITESPACE_RE, " ").trim())
    .filter((part) => part.length > 0)
    .join("; ");
  if (!message) {
    return null;
  }
  return message.length > JIRA_ERROR_DETAIL_MAX
    ? `${message.slice(0, JIRA_ERROR_DETAIL_MAX - 1)}…`
    : message;
}

function withDetail(message: string, detail: string | null): string {
  return detail ? `${message}: ${detail}` : message;
}
