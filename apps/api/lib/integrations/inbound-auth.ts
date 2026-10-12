import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { InboundVerification } from "./types";

/**
 * Shared verification primitives for inbound webhooks. Every comparison is
 * constant-time. Providers combine them in their `inbound.verify`.
 *
 * Static tokens travel in a custom header, never in `Authorization: Bearer`:
 * the API middleware parses bearer values as session JWTs.
 */

/** Header carrying the connection's inbound secret for sources that cannot sign (Jira Automation, ADO service hooks). */
export const INBOUND_TOKEN_HEADER = "x-agentflow-token";

/** The token header as setup instructions show it (header names are case-insensitive). */
export const INBOUND_TOKEN_HEADER_DISPLAY = "X-AgentFlow-Token";

/** Standard Webhooks timestamp tolerance (https://www.standardwebhooks.com/). */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 300;

const STANDARD_WEBHOOK_SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION_PREFIX = "v1,";
const DIGITS_RE = /^\d{1,12}$/;

/** 32 random bytes, base64url. The default inbound secret for every provider. */
export function generateInboundSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** `whsec_` + 32 random bytes base64, the Standard Webhooks secret format. */
export function generateStandardWebhookSecret(): string {
  return `${STANDARD_WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Compare against itself so the timing does not depend on where they differ.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * WebSub-style `X-Hub-Signature: <method>=<hex hmac of raw body>` as sent by
 * Jira admin webhooks. The method is read from the header (Jira may change it)
 * but only sha256/sha512 are accepted.
 */
export function verifyHubSignature(
  rawBody: string,
  header: string | null,
  secret: string
): InboundVerification {
  if (!header) {
    return { ok: false, reason: "missing_signature" };
  }
  const separator = header.indexOf("=");
  if (separator <= 0) {
    return { ok: false, reason: "malformed_signature" };
  }
  const method = header.slice(0, separator).trim().toLowerCase();
  const received = header
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  if (method !== "sha256" && method !== "sha512") {
    return { ok: false, reason: "unsupported_signature_method" };
  }
  const expected = createHmac(method, secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return constantTimeEqual(received, expected)
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

/**
 * Accepts the secret either in the X-AgentFlow-Token header or as the
 * password of HTTP Basic auth (Azure DevOps service hooks offer both).
 */
export function verifyStaticToken(
  headers: Headers,
  secret: string
): InboundVerification {
  const headerToken = headers.get(INBOUND_TOKEN_HEADER);
  if (headerToken) {
    return constantTimeEqual(headerToken.trim(), secret)
      ? { ok: true }
      : { ok: false, reason: "token_mismatch" };
  }
  const basicPassword = readBasicAuthPassword(headers.get("authorization"));
  if (basicPassword !== null) {
    return constantTimeEqual(basicPassword, secret)
      ? { ok: true }
      : { ok: false, reason: "token_mismatch" };
  }
  return { ok: false, reason: "missing_token" };
}

/**
 * Standard Webhooks (webhook-id / webhook-timestamp / webhook-signature, with
 * svix-* aliases). `secret` is the `whsec_...` value.
 */
export function verifyStandardWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): InboundVerification {
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp =
    headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const signatures =
    headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!(id && timestamp && signatures)) {
    return { ok: false, reason: "missing_signature" };
  }
  const timestampSeconds = DIGITS_RE.test(timestamp)
    ? Number.parseInt(timestamp, 10)
    : Number.NaN;
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > STANDARD_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  const expected = signStandardWebhook(id, timestampSeconds, rawBody, secret);
  const matched = signatures
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(SIGNATURE_VERSION_PREFIX))
    .some((entry) => constantTimeEqual(entry, expected));
  return matched ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

/** Returns the `v1,<base64>` signature for a Standard Webhooks message. */
export function signStandardWebhook(
  id: string,
  timestampSeconds: number,
  rawBody: string,
  secret: string
): string {
  const key = Buffer.from(
    secret.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)
      ? secret.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length)
      : secret,
    "base64"
  );
  const digest = createHmac("sha256", key)
    .update(`${id}.${timestampSeconds}.${rawBody}`, "utf8")
    .digest("base64");
  return `${SIGNATURE_VERSION_PREFIX}${digest}`;
}

function readBasicAuthPassword(authorization: string | null): string | null {
  if (!authorization?.toLowerCase().startsWith("basic ")) {
    return null;
  }
  const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString(
    "utf8"
  );
  const separator = decoded.indexOf(":");
  return separator === -1 ? null : decoded.slice(separator + 1);
}
