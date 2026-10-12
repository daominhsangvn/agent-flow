import { BlockList, isIP } from "node:net";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";

/**
 * Guard for the `callbackUrl` an inbound request supplies. That URL comes
 * from whoever holds the connection's inbound secret (an external system,
 * not a AgentFlow user), so webhook.post only calls it when its host is in
 * the connection's allowed callback hosts or, with no list, when the host is
 * not a local or private address. URLs an admin configured (action URL,
 * default callback URL) are not checked: self-hosted installs legitimately
 * call internal services.
 *
 * Only the literal host of the URL is checked (no DNS resolution). Use the
 * allow list to pin request callbacks to known hosts.
 */

export const ALLOWED_CALLBACK_HOSTS_MAX = 50;

/** Longest DNS name. */
const HOST_MAX_LENGTH = 253;
const HOST_FORMAT_ERROR =
  "enter a host name only, e.g. hooks.example.com (no scheme, port or path)";
/** Characters that never appear in a bare host (scheme, path, query, fragment, user info, zone id). */
const HOST_ENTRY_FORBIDDEN_RE = /[\s/?#@\\%]/;
const LOCAL_HOSTNAME = "localhost";
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];
const IP_VERSION_6 = 6;
const PRIVATE_ADDRESSES = buildPrivateAddressList();

/**
 * Connection config value: host names, trimmed, lowercased, without a
 * trailing dot, de-duplicated. IPv6 addresses are stored without brackets.
 */
export const allowedCallbackHostsSchema = z
  .array(z.string().max(HOST_MAX_LENGTH))
  .max(ALLOWED_CALLBACK_HOSTS_MAX)
  .nullish()
  .transform(normalizeAllowedHosts);

/**
 * Ok(url) when webhook.post may call the request's callback URL; otherwise
 * the reason, completing "The request's callbackUrl was not used: ...".
 */
export function checkRequestCallbackUrl(
  url: string,
  allowedHosts: readonly string[]
): Result<string, string> {
  if (!URL.canParse(url)) {
    return Result.err("it is not a valid URL");
  }
  const host = normalizeHostname(new URL(url).hostname);
  if (allowedHosts.length > 0) {
    return allowedHosts.includes(host)
      ? Result.ok(url)
      : Result.err(
          `its host ${host} is not in the connection's allowed callback hosts`
        );
  }
  if (isLocalOrPrivateHost(host)) {
    return Result.err(
      `its host ${host} is a local or private address (list it in the connection's allowed callback hosts to allow it)`
    );
  }
  return Result.ok(url);
}

/**
 * localhost, *.localhost, *.local, *.internal, single-label names (resolved
 * through the server's DNS search domains), and literal loopback, private,
 * carrier-grade NAT, link-local, unique-local and unspecified addresses,
 * including IPv4-mapped IPv6 forms of them.
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  const ipVersion = isIP(host);
  if (ipVersion === 0) {
    return isLocalHostname(host);
  }
  return PRIVATE_ADDRESSES.check(
    host,
    ipVersion === IP_VERSION_6 ? "ipv6" : "ipv4"
  );
}

function normalizeAllowedHosts(
  values: string[] | null | undefined,
  context: z.RefinementCtx
): string[] {
  const hosts: string[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    const trimmed = value.trim();
    if (trimmed === "") {
      continue;
    }
    const host = normalizeHostEntry(trimmed);
    if (host === null) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `"${trimmed}": ${HOST_FORMAT_ERROR}`,
      });
    } else if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

/** A bare host (DNS name, IPv4 or IPv6 address) in its normalized form, or null. */
function normalizeHostEntry(value: string): string | null {
  if (HOST_ENTRY_FORBIDDEN_RE.test(value)) {
    return null;
  }
  const unbracketed = stripBrackets(value);
  if (isIP(unbracketed) === IP_VERSION_6) {
    return hostOf(`http://[${unbracketed}]/`);
  }
  if (value.includes(":") || value.includes("[") || value.includes("]")) {
    return null;
  }
  return hostOf(`http://${value}/`);
}

function hostOf(url: string): string | null {
  if (!URL.canParse(url)) {
    return null;
  }
  const host = normalizeHostname(new URL(url).hostname);
  return host === "" ? null : host;
}

/** Lowercase, without IPv6 brackets and without the trailing dot of a fully qualified name. */
function normalizeHostname(hostname: string): string {
  const bare = stripBrackets(hostname.toLowerCase());
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function isLocalHostname(host: string): boolean {
  if (host === LOCAL_HOSTNAME || !host.includes(".")) {
    return true;
  }
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function buildPrivateAddressList(): BlockList {
  const list = new BlockList();
  // IPv4: "this network" (incl. 0.0.0.0), private, carrier-grade NAT,
  // loopback, link-local (cloud metadata endpoints). BlockList also matches
  // the IPv4-mapped IPv6 form (::ffff:a.b.c.d) of these.
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  // IPv6: unspecified, loopback and deprecated IPv4-compatible (::/96),
  // unique-local (fc00::/7), link-local (fe80::/10).
  list.addSubnet("::", 96, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  return list;
}
