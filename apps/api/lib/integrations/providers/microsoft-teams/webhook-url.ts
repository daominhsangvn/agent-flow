import { Result } from "@repo/api/src/types/result";

/**
 * Checks for the Teams Workflows webhook URL ("When a Teams webhook request
 * is received" trigger). The URL embeds a SAS signature, so it is stored as a
 * secret and never echoed back in errors or logs.
 */

export const TEAMS_RETIRED_CONNECTOR_ERROR =
  'This is an Office 365 connector ("Incoming Webhook") URL. Microsoft retired Office 365 connectors in Teams in 2026, so these URLs no longer deliver messages. Create a Workflows webhook instead: in the Teams channel open ••• > Workflows, pick the "Send webhook alerts to a channel" template, finish the setup and paste the URL it shows here.';

export const TEAMS_INVALID_URL_ERROR =
  "Enter the full Workflows webhook URL copied from Teams (it starts with https://).";

export const TEAMS_HTTPS_REQUIRED_ERROR =
  "The Teams Workflows webhook URL must start with https://.";

/** Hosts of the retired Office 365 connector webhooks. */
const RETIRED_CONNECTOR_HOSTS = new Set([
  "outlook.office.com",
  "outlook.office365.com",
  "webhook.office.com",
]);
const RETIRED_CONNECTOR_HOST_SUFFIX = ".webhook.office.com";

/** Plain http is only accepted for local test doubles. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A missing value counts as malformed, so action execution never throws on a damaged connection. */
export function checkTeamsWebhookUrl(
  value: string | null | undefined
): Result<URL, string> {
  const url = value ? URL.parse(value.trim()) : null;
  if (!url) {
    return Result.err(TEAMS_INVALID_URL_ERROR);
  }
  if (isRetiredConnectorHost(url.hostname)) {
    return Result.err(TEAMS_RETIRED_CONNECTOR_ERROR);
  }
  if (url.protocol === "https:") {
    return Result.ok(url);
  }
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) {
    return Result.ok(url);
  }
  return Result.err(TEAMS_HTTPS_REQUIRED_ERROR);
}

function isRetiredConnectorHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    RETIRED_CONNECTOR_HOSTS.has(host) ||
    host.endsWith(RETIRED_CONNECTOR_HOST_SUFFIX)
  );
}
