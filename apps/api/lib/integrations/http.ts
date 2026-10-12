import { parseError } from "@repo/observability/error";
import type {
  ProviderHttp,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * HTTP client handed to provider code. It never throws, bounds every request
 * with a timeout and every response body with a byte cap, and classifies
 * failures as retryable or not so post actions can be retried by the outbox.
 * Error texts never contain the request URL (some URLs, like Teams Workflows
 * webhooks, are bearer secrets). `fetchImpl` is injectable for tests.
 */
export function createProviderHttp(
  fetchImpl: typeof fetch = fetch
): ProviderHttp {
  return {
    request: (request) => sendRequest(fetchImpl, request),
  };
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

async function sendRequest(
  fetchImpl: typeof fetch,
  request: ProviderHttpRequest
): Promise<ProviderHttpResponse> {
  if (!isAllowedUrl(request.url)) {
    return failure("Invalid URL", false);
  }

  const headers: Record<string, string> = { ...request.headers };
  if (!hasHeader(headers, "accept")) {
    headers.accept = "application/json";
  }
  let body: string | undefined;
  if (typeof request.body === "string") {
    body = request.body;
  } else if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    if (!hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/json";
    }
  }

  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      body,
      redirect: request.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await readCappedText(response, MAX_RESPONSE_BYTES);
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text,
      json: parseJsonBody(response.headers, text),
      error: response.ok ? null : `HTTP ${response.status}`,
      retryable: !response.ok && isRetryableStatus(response.status),
    };
  } catch (error) {
    return failure(parseError(error).replaceAll(request.url, "[url]"), true);
  }
}

function failure(error: string, retryable: boolean): ProviderHttpResponse {
  return {
    ok: false,
    status: 0,
    headers: new Headers(),
    text: "",
    json: undefined,
    error,
    retryable,
  };
}

function isAllowedUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Reads at most `maxBytes` of the body and cancels the rest of the stream. */
async function readCappedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    const remaining = maxBytes - received;
    const chunk =
      value.byteLength > remaining ? value.subarray(0, remaining) : value;
    received += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

function parseJsonBody(headers: Headers, text: string): unknown {
  const contentType = headers.get("content-type") ?? "";
  if (!(contentType.includes("json") && text)) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
