import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Local envelope for secrets at rest (Claude API keys, integration OAuth
 * tokens). Replaces the former AWS KMS calls so self-hosted deployments need no
 * cloud key service: AES-256-GCM with a 32-byte master key from
 * `ENCRYPTION_KEY` (base64).
 *
 * The caller-supplied `purpose` is bound as GCM additional authenticated data,
 * which gives the same cryptographic separation KMS encryption contexts did: a
 * ciphertext sealed for "claude-api-key" will not open as "integration-token".
 *
 * Wire format: `v1.<base64(iv | authTag | ciphertext)>`. The version prefix
 * leaves room for key rotation without guessing at the payload layout.
 */

const ALGORITHM = "aes-256-gcm";
const FORMAT_PREFIX = "v1.";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export const SecretPurpose = {
  ClaudeApiKey: "claude-api-key",
  IntegrationToken: "integration-token",
  // Sealed JSON of an IntegrationConnection's secret fields.
  IntegrationCredentials: "integration-credentials",
  // An IntegrationConnection's inbound webhook secret (HMAC key or static token).
  IntegrationInboundSecret: "integration-inbound-secret",
  // Auth token of a compute target's model provider (e.g. a DeepSeek key).
  ComputeTargetModelToken: "compute-target-model-token",
} as const;
export type SecretPurpose = (typeof SecretPurpose)[keyof typeof SecretPurpose];

let cachedKey: Buffer | null = null;

export function encryptSecret(
  plaintext: string,
  purpose: SecretPurpose
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getMasterKey(), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `${FORMAT_PREFIX}${payload.toString("base64")}`;
}

export function decryptSecret(sealed: string, purpose: SecretPurpose): string {
  if (!sealed.startsWith(FORMAT_PREFIX)) {
    throw new Error("Unsupported secret format: expected a v1 sealed value");
  }
  const payload = Buffer.from(sealed.slice(FORMAT_PREFIX.length), "base64");
  if (payload.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Sealed secret is truncated");
  }
  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, getMasterKey(), iv);
  decipher.setAAD(Buffer.from(purpose, "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** Test-only: drop the memoized key so a test can swap `ENCRYPTION_KEY`. */
export function resetSecretEncryptionKeyForTests(): void {
  cachedKey = null;
}

function getMasterKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not configured. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  cachedKey = key;
  return key;
}
