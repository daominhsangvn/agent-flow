import { isLoopbackIPv4 } from "../../shared/network-utils.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Comma-separated host names that may be reached over plain http in addition
 * to loopback, for self-hosted deployments without TLS on a trusted network
 * (e.g. `host.docker.internal` for a runner container talking to an API on
 * the same machine). Exact, case-insensitive host names only; never set by
 * default. The desktop API key travels over this connection, so only list
 * hosts on a network you trust.
 */
export const ALLOW_HTTP_HOSTS_ENV = "AGENTFLOW_ALLOW_HTTP_HOSTS";

export function normalizeAndValidateOrigin(rawOrigin: string): string {
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    throw new Error("Origin is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Origin must be a valid URL");
  }

  if (parsed.protocol === "https:") {
    return parsed.origin;
  }

  if (parsed.protocol === "http:" && isHttpAllowedHost(parsed.hostname)) {
    return parsed.origin;
  }

  throw new Error(
    `Origin must use https (http is allowed only for localhost/127.0.0.1 in local development, or hosts listed in ${ALLOW_HTTP_HOSTS_ENV})`
  );
}

export function normalizeWebAppOrigin(rawOrigin: string): string {
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    throw new Error("Web app origin is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Web app origin must be a valid URL");
  }

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isHttpAllowedHost(parsed.hostname))
  ) {
    throw new Error(
      `Web app origin must use https (http is allowed only for localhost/127.0.0.1 in local development, or hosts listed in ${ALLOW_HTTP_HOSTS_ENV})`
    );
  }

  return parsed.origin;
}

function isHttpAllowedHost(hostname: string): boolean {
  return (
    isLoopbackHost(hostname) || explicitHttpHosts().has(hostname.toLowerCase())
  );
}

function explicitHttpHosts(): ReadonlySet<string> {
  const configured = process.env[ALLOW_HTTP_HOSTS_ENV] ?? "";
  return new Set(
    configured
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    return true;
  }
  return isLoopbackIPv4(hostname);
}
