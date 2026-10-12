import type { JsonObject } from "@repo/api/src/types/common";
import { signStandardWebhook } from "../../inbound-auth";
import {
  HttpMethod,
  type ProviderHttp,
  type ProviderHttpResponse,
} from "../../types";
import { redactUrls } from "./urls";

/**
 * Outbound JSON POSTs of the generic HTTPS provider, signed with Standard
 * Webhooks headers (webhook-id / webhook-timestamp / webhook-signature) when
 * the connection has a signing secret. Redirects are never followed: the
 * target may come from an inbound request, and a redirect would let it steer
 * the request elsewhere (a 3xx is reported as a failed delivery).
 */

export const WEBHOOK_USER_AGENT = "AgentFlow-Workflows";
/** Delivery attempt of an action run (1 on the first, higher on retries). */
export const WEBHOOK_ATTEMPT_HEADER = "x-agentflow-attempt";

const OUTBOUND_TIMEOUT_MS = 15_000;

export type OutboundWebhookRequest = {
  url: string;
  payload: JsonObject;
  /** Standard Webhooks message id (webhook-id header); keep it stable across retries. */
  messageId: string;
  /** Delivery attempt (1 on the first), sent as x-agentflow-attempt when set. */
  attempt?: number;
  /** null sends the request unsigned. */
  signingSecret: string | null;
  now: Date;
};

export function sendOutboundWebhook(
  http: ProviderHttp,
  request: OutboundWebhookRequest
): Promise<ProviderHttpResponse> {
  const rawBody = JSON.stringify(request.payload);
  return http.request({
    method: HttpMethod.Post,
    url: request.url,
    headers: buildOutboundHeaders(rawBody, request),
    body: rawBody,
    timeoutMs: OUTBOUND_TIMEOUT_MS,
    followRedirects: false,
  });
}

export function buildOutboundHeaders(
  rawBody: string,
  request: Pick<
    OutboundWebhookRequest,
    "messageId" | "signingSecret" | "now" | "attempt"
  >
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
  };
  if (request.attempt !== undefined) {
    headers[WEBHOOK_ATTEMPT_HEADER] = String(request.attempt);
  }
  if (!request.signingSecret) {
    return headers;
  }
  const timestampSeconds = Math.floor(request.now.getTime() / 1000);
  headers["webhook-id"] = request.messageId;
  headers["webhook-timestamp"] = String(timestampSeconds);
  headers["webhook-signature"] = signStandardWebhook(
    request.messageId,
    timestampSeconds,
    rawBody,
    request.signingSecret
  );
  return headers;
}

/** Completes "The <target> ..." with what went wrong; never contains the URL. */
export function describeOutboundFailure(
  response: ProviderHttpResponse
): string {
  if (response.status !== 0) {
    return `answered HTTP ${response.status}`;
  }
  const cause = response.error ? `: ${redactUrls(response.error)}` : "";
  return `could not be reached (network error or timeout)${cause}`;
}
