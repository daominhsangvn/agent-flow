import { isLocalOrPrivateHost } from "./providers/webhook/callback-hosts";

/**
 * Whether the inbound URL shown to the admin can be called from the
 * internet. Jira Cloud only calls public HTTPS URLs and Azure DevOps refuses
 * localhost and private addresses, so a URL built from the default
 * `http://localhost:3002` silently receives nothing. Only the literal host is
 * checked (no DNS resolution).
 */

const PUBLIC_BASE_URL_HINT =
  "Set PUBLIC_WEBHOOK_BASE_URL on the API to a public HTTPS address that forwards to it (a reverse proxy, Cloudflare Tunnel or ngrok), restart the API and copy the new URL, or switch this connection to Poll, which needs no public URL.";

/** Null when the URL looks reachable from the internet, else why it is not. */
export function inboundUrlWarning(inboundUrl: string): string | null {
  if (!URL.canParse(inboundUrl)) {
    return `The inbound URL ${inboundUrl} is not a valid URL. ${PUBLIC_BASE_URL_HINT}`;
  }
  const url = new URL(inboundUrl);
  if (isLocalOrPrivateHost(url.hostname)) {
    return `Services on the internet such as Jira Cloud and Azure DevOps cannot reach ${url.host}: it is a local or private address. ${PUBLIC_BASE_URL_HINT}`;
  }
  if (url.protocol !== "https:") {
    return `Jira Cloud and Azure DevOps only deliver to HTTPS URLs, and this one uses ${url.protocol.slice(0, -1)}. ${PUBLIC_BASE_URL_HINT}`;
  }
  return null;
}
