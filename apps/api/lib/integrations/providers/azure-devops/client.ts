import type { JsonValue } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { z } from "zod";
import type {
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../../types";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoErrorBodySchema,
} from "./schemas";

/**
 * Authenticated access to the Azure DevOps REST API for one connection.
 *
 * Every call returns a Result: expected failures (bad token, missing item,
 * rule violation, outage) are values with a user-facing message that never
 * contains the token. ADO answers a bad PAT with 401, or with 203 / a
 * redirect to an HTML sign-in page; all of those map to `unauthorized`.
 */

export const ADO_API_VERSION = "7.1";
/** The Comments API is still preview in 7.1. */
export const ADO_COMMENTS_API_VERSION = "7.1-preview.4";
export const JSON_PATCH_CONTENT_TYPE = "application/json-patch+json";
export const ADO_TOKEN_REJECTED_MESSAGE =
  "Azure DevOps rejected the personal access token";

export type AdoContext = ProviderContext<AdoConnectionConfig, AdoSecrets>;

export const AdoErrorKind = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  BadRequest: "bad_request",
  Unavailable: "unavailable",
  InvalidResponse: "invalid_response",
} as const;
export type AdoErrorKind = (typeof AdoErrorKind)[keyof typeof AdoErrorKind];

export type AdoError = {
  kind: AdoErrorKind;
  status: number;
  /** User-facing; includes the ADO error message when there is one. */
  message: string;
  retryable: boolean;
};

export type AdoQueryValue = string | number | boolean | undefined;

export type AdoRequest = {
  method: ProviderHttpRequest["method"];
  /** Path below the organization URL, without a leading slash, with segments already encoded. */
  path: string;
  query?: Record<string, AdoQueryValue>;
  body?: JsonValue;
  /** Overrides the JSON content type (e.g. JSON Patch). */
  contentType?: string;
};

export async function adoRequest<T>(
  ctx: AdoContext,
  request: AdoRequest,
  schema: z.ZodType<T>
): Promise<Result<T, AdoError>> {
  const response = await ctx.http.request({
    method: request.method,
    url: buildAdoUrl(
      ctx.connection.config.organizationUrl,
      request.path,
      request.query
    ),
    headers: buildHeaders(ctx.connection.secrets.pat, request.contentType),
    body: request.body,
  });
  const failure = classifyFailure(response);
  if (failure) {
    return Result.err(failure);
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return Result.err({
      kind: AdoErrorKind.InvalidResponse,
      status: response.status,
      message: "Azure DevOps returned an unexpected response",
      retryable: false,
    });
  }
  return Result.ok(parsed.data);
}

/** Browser URL of a work item. Falls back to the organization-level route without a project. */
export function workItemWebUrl(
  organizationUrl: string,
  project: string | null,
  workItemId: number
): string {
  const base = trimTrailingSlashes(organizationUrl);
  return project
    ? `${base}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`
    : `${base}/_workitems/edit/${workItemId}`;
}

/** Encodes a project name or id as one URL path segment. */
export function projectSegment(project: string): string {
  return encodeURIComponent(project);
}

export function buildAdoUrl(
  organizationUrl: string,
  path: string,
  query: Record<string, AdoQueryValue> | undefined
): string {
  const base = `${trimTrailingSlashes(organizationUrl)}/${path}`;
  const search = Object.entries(query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    })
    .map(
      ([key, value]) =>
        `${encodeQueryKey(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
  return search ? `${base}?${search}` : base;
}

const ADO_ERROR_DETAIL_MAX = 300;
const WHITESPACE_RE = /\s+/g;

function buildHeaders(
  pat: string,
  contentType: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`,
    // Ask ADO for a plain 401 instead of a redirect to the sign-in page.
    "x-tfs-fedauthredirect": "Suppress",
  };
  if (contentType) {
    headers["content-type"] = contentType;
  }
  return headers;
}

function classifyFailure(response: ProviderHttpResponse): AdoError | null {
  if (response.status === 0) {
    return {
      kind: AdoErrorKind.Unavailable,
      status: 0,
      message: `Could not reach Azure DevOps (${response.error ?? "network error"})`,
      retryable: response.retryable,
    };
  }
  // 203 Non-Authoritative Information carries the HTML sign-in page for a bad PAT.
  if (response.status === 401 || response.status === 203) {
    return unauthorizedError(response.status);
  }
  if (response.ok) {
    return classifyNonJsonSuccess(response);
  }
  return classifyErrorStatus(response);
}

function classifyNonJsonSuccess(
  response: ProviderHttpResponse
): AdoError | null {
  if (response.json !== undefined) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    return unauthorizedError(response.status);
  }
  return {
    kind: AdoErrorKind.InvalidResponse,
    status: response.status,
    message: "Azure DevOps returned an unexpected response",
    retryable: false,
  };
}

function classifyErrorStatus(response: ProviderHttpResponse): AdoError {
  const detail = readAdoErrorMessage(response.json);
  if (response.status === 403) {
    return {
      kind: AdoErrorKind.Forbidden,
      status: 403,
      message: withDetail(
        "Azure DevOps denied access; check the token scopes (Work Items: Read & write)",
        detail
      ),
      retryable: false,
    };
  }
  if (response.status === 404) {
    return {
      kind: AdoErrorKind.NotFound,
      status: 404,
      message: withDetail("Not found in Azure DevOps", detail),
      retryable: false,
    };
  }
  if (response.retryable) {
    return {
      kind: AdoErrorKind.Unavailable,
      status: response.status,
      message: withDetail(
        `Azure DevOps is unavailable (HTTP ${response.status})`,
        detail
      ),
      retryable: true,
    };
  }
  return {
    kind: AdoErrorKind.BadRequest,
    status: response.status,
    message: withDetail(
      `Azure DevOps rejected the request (HTTP ${response.status})`,
      detail
    ),
    retryable: false,
  };
}

function unauthorizedError(status: number): AdoError {
  return {
    kind: AdoErrorKind.Unauthorized,
    status,
    message: ADO_TOKEN_REJECTED_MESSAGE,
    retryable: false,
  };
}

function readAdoErrorMessage(json: unknown): string | null {
  const parsed = adoErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const message = parsed.data.message.replaceAll(WHITESPACE_RE, " ").trim();
  if (!message) {
    return null;
  }
  return message.length > ADO_ERROR_DETAIL_MAX
    ? `${message.slice(0, ADO_ERROR_DETAIL_MAX - 1)}…`
    : message;
}

function withDetail(message: string, detail: string | null): string {
  return detail ? `${message}: ${detail}` : message;
}

/** ADO documents `$top`, `$expand`, ... with a literal `$`; keep it unencoded. */
function encodeQueryKey(key: string): string {
  return key.startsWith("$")
    ? `$${encodeURIComponent(key.slice(1))}`
    : encodeURIComponent(key);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}
