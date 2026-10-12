/**
 * Outbound signing secrets follow Standard Webhooks: `whsec_` + base64 of
 * random bytes. The prefix is optional (signStandardWebhook strips it).
 */

const STANDARD_WEBHOOK_SECRET_PREFIX = "whsec_";
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_SECRET_BYTES = 16;

export const SIGNING_SECRET_ERROR =
  'The signing secret must be a Standard Webhooks secret: "whsec_" followed by base64 of at least 16 random bytes (32 recommended). Leave it empty to send unsigned requests.';

export function isValidSigningSecret(value: string): boolean {
  const encoded = value.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)
    ? value.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length)
    : value;
  return (
    BASE64_RE.test(encoded) &&
    Buffer.from(encoded, "base64").length >= MIN_SECRET_BYTES
  );
}

/** The configured secret, or null when outbound requests go unsigned. */
export function readSigningSecret(
  signingSecret: string | null | undefined
): string | null {
  const trimmed = signingSecret?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
