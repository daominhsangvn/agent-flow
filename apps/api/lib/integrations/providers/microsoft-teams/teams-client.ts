import type { JsonObject } from "@repo/api/src/types/common";
import { z } from "zod";
import {
  HttpMethod,
  type ProviderHttp,
  type ProviderHttpResponse,
} from "../../types";

/**
 * Posting to a Teams Workflows webhook. The webhook answers 202 once the flow
 * accepted the request (rendering happens later, inside the flow). Error
 * messages never contain the webhook URL: it carries a SAS signature.
 */

const TEAMS_REQUEST_TIMEOUT_MS = 15_000;
const URL_IN_TEXT_RE = /\bhttps?:\/\/\S+/gi;
const SAS_SIGNATURE_RE = /\bsig=[^&\s"']+/gi;

/** Power Automate error envelope: {"error":{"code":"...","message":"..."}}. */
const powerAutomateErrorSchema = z.object({
  error: z.object({ code: z.string().min(1).max(100) }),
});

export function postTeamsMessage(
  http: ProviderHttp,
  webhookUrl: URL,
  payload: JsonObject
): Promise<ProviderHttpResponse> {
  return http.request({
    method: HttpMethod.Post,
    url: webhookUrl.toString(),
    body: payload,
    timeoutMs: TEAMS_REQUEST_TIMEOUT_MS,
  });
}

/** User-facing description of a failed post; safe to store and show (no URL, no signature). */
export function describeTeamsFailure(response: ProviderHttpResponse): string {
  if (response.status === 0) {
    const cause = response.error ? `: ${redactUrls(response.error)}` : "";
    return `Could not reach the Teams Workflows webhook (network error or timeout)${cause}.`;
  }
  const errorCode = powerAutomateErrorSchema.safeParse(response.json);
  const code = errorCode.success ? `, ${errorCode.data.error.code}` : "";
  return `${statusHint(response.status)} (HTTP ${response.status}${code})`;
}

/** Removes URLs and SAS signatures from transport error text. */
export function redactUrls(text: string): string {
  return text
    .replaceAll(URL_IN_TEXT_RE, "[url]")
    .replaceAll(SAS_SIGNATURE_RE, "sig=[redacted]");
}

function statusHint(status: number): string {
  if (status === 400) {
    return 'Teams rejected the message. Check that the workflow starts with the "When a Teams webhook request is received" trigger';
  }
  if (status === 401 || status === 403) {
    return 'Teams refused the request. Set "Who can trigger the flow" to "Anyone" on the workflow trigger, or recreate it from the "Send webhook alerts to a channel" template';
  }
  if (status === 404) {
    return "The Teams workflow was not found. It may have been deleted or turned off; create a new Workflows webhook and update the connection";
  }
  if (status === 429) {
    return "Teams is throttling requests";
  }
  if (status >= 500) {
    return "Microsoft Teams had a temporary error";
  }
  return "Teams did not accept the message";
}
