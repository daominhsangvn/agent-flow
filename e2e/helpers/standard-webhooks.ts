import { createHmac } from "node:crypto";

/**
 * Client side of Standard Webhooks (https://www.standardwebhooks.com/), used
 * to sign requests to the generic HTTPS ("webhook") integration trigger:
 *
 *   webhook-signature = "v1," + base64(HMAC-SHA256(key, `${id}.${ts}.${body}`))
 *
 * where the key is the base64-decoded secret without its `whsec_` prefix.
 */

export const StandardWebhookHeader = {
  Id: "webhook-id",
  Timestamp: "webhook-timestamp",
  Signature: "webhook-signature",
} as const;
export type StandardWebhookHeader =
  (typeof StandardWebhookHeader)[keyof typeof StandardWebhookHeader];

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION_PREFIX = "v1,";

export type StandardWebhookMessage = {
  id: string;
  timestampSeconds: number;
  rawBody: string;
  secret: string;
};

export function signStandardWebhookMessage({
  id,
  timestampSeconds,
  rawBody,
  secret,
}: StandardWebhookMessage): string {
  const key = Buffer.from(
    secret.startsWith(SECRET_PREFIX)
      ? secret.slice(SECRET_PREFIX.length)
      : secret,
    "base64"
  );
  const digest = createHmac("sha256", key)
    .update(`${id}.${timestampSeconds}.${rawBody}`, "utf8")
    .digest("base64");
  return `${SIGNATURE_VERSION_PREFIX}${digest}`;
}

/** Headers for a signed JSON delivery. The timestamp defaults to now. */
export function buildStandardWebhookHeaders({
  id,
  rawBody,
  secret,
  timestampSeconds = Math.floor(Date.now() / 1000),
}: Omit<StandardWebhookMessage, "timestampSeconds"> & {
  timestampSeconds?: number;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    [StandardWebhookHeader.Id]: id,
    [StandardWebhookHeader.Timestamp]: String(timestampSeconds),
    [StandardWebhookHeader.Signature]: signStandardWebhookMessage({
      id,
      timestampSeconds,
      rawBody,
      secret,
    }),
  };
}
