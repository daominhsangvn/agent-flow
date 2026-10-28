import type { JsonObject } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import {
  HttpMethod,
  type ProviderHttp,
  type ProviderHttpResponse,
} from "../../types";

/**
 * Calls to the Bot Connector service of a Teams activity (its serviceUrl):
 * sending a message to a conversation and reading a team's details. The
 * bot's token is only ever sent to Teams' own service hosts, whatever a
 * stored serviceUrl says.
 */

const CONNECTOR_TIMEOUT_MS = 15_000;
const TRAILING_SLASHES_RE = /\/+$/;
/** Commercial cloud (regional paths under one host). */
const SERVICE_HOSTS = new Set(["smba.trafficmanager.net"]);
/** GCC, GCC High and DoD: smba.infra.<cloud>.teams.microsoft.{com,us}. */
const SERVICE_HOST_RE =
  /^smba\.infra\.[a-z0-9-]+\.teams\.microsoft\.(com|us)$/i;

const teamDetailsSchema = z.looseObject({
  aadGroupId: z.string().min(1),
});

const sentActivitySchema = z.looseObject({ id: z.string().min(1) });

/** The service URL without trailing slashes when it is a Teams Bot Connector host, else null. */
export function checkServiceUrl(value: string | null | undefined): URL | null {
  const url = value
    ? URL.parse(value.trim().replace(TRAILING_SLASHES_RE, ""))
    : null;
  if (url?.protocol !== "https:" || url.username || url.password) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return SERVICE_HOSTS.has(host) || SERVICE_HOST_RE.test(host) ? url : null;
}

export async function sendToConversation(
  http: ProviderHttp,
  input: {
    serviceUrl: URL;
    token: string;
    conversationId: string;
    activity: JsonObject;
  }
): Promise<Result<{ id: string | null }, ProviderHttpResponse>> {
  const response = await http.request({
    method: HttpMethod.Post,
    url: `${connectorBase(input.serviceUrl)}/v3/conversations/${encodeURIComponent(input.conversationId)}/activities`,
    headers: { authorization: `Bearer ${input.token}` },
    body: input.activity,
    timeoutMs: CONNECTOR_TIMEOUT_MS,
  });
  if (!response.ok) {
    return Result.err(response);
  }
  const sent = sentActivitySchema.safeParse(response.json);
  return Result.ok({ id: sent.success ? sent.data.id : null });
}

/** Replaces a message the bot sent to a conversation. */
export async function updateActivity(
  http: ProviderHttp,
  input: {
    serviceUrl: URL;
    token: string;
    conversationId: string;
    activityId: string;
    activity: JsonObject;
  }
): Promise<Result<{ id: string | null }, ProviderHttpResponse>> {
  const response = await http.request({
    method: HttpMethod.Put,
    url: `${connectorBase(input.serviceUrl)}/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(input.activityId)}`,
    headers: { authorization: `Bearer ${input.token}` },
    body: { ...input.activity, id: input.activityId },
    timeoutMs: CONNECTOR_TIMEOUT_MS,
  });
  if (!response.ok) {
    return Result.err(response);
  }
  const sent = sentActivitySchema.safeParse(response.json);
  return Result.ok({ id: sent.success ? sent.data.id : input.activityId });
}

/** The team's Microsoft 365 group id (Graph's team id), from its Teams id. */
export async function getTeamGroupId(
  http: ProviderHttp,
  input: { serviceUrl: URL; token: string; teamId: string }
): Promise<string | null> {
  const response = await http.request({
    method: HttpMethod.Get,
    url: `${connectorBase(input.serviceUrl)}/v3/teams/${encodeURIComponent(input.teamId)}`,
    headers: { authorization: `Bearer ${input.token}` },
    timeoutMs: CONNECTOR_TIMEOUT_MS,
  });
  const details = teamDetailsSchema.safeParse(response.json);
  return response.ok && details.success ? details.data.aadGroupId : null;
}

/** User-facing description of a failed send. */
export function describeConnectorFailure(
  response: ProviderHttpResponse
): string {
  if (response.status === 0) {
    return "Could not reach the Teams Bot Connector (network error or timeout).";
  }
  if (response.status === 401 || response.status === 403) {
    return `Teams refused the bot's message (HTTP ${response.status}). Check that the bot's app registration and client secret are those of the Azure Bot, and that the app is still installed in the team.`;
  }
  if (response.status === 404) {
    return "Teams did not find the conversation (HTTP 404): the thread may have been deleted, or the app removed from the team.";
  }
  if (response.status === 429) {
    return "Teams is throttling the bot (HTTP 429).";
  }
  if (response.status >= 500) {
    return `Microsoft Teams had a temporary error (HTTP ${response.status}).`;
  }
  return `Teams did not accept the bot's message (HTTP ${response.status}).`;
}

function connectorBase(serviceUrl: URL): string {
  return serviceUrl.toString().replace(TRAILING_SLASHES_RE, "");
}
