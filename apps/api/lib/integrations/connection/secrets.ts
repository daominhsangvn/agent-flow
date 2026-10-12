import { randomBytes } from "node:crypto";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { parseError } from "@repo/observability/error";
import { jsonObjectSchema } from "@/lib/json-schema";
import {
  decryptSecret,
  encryptSecret,
  SecretPurpose,
} from "@/lib/secret-encryption";

/**
 * Secret handling for integration connections. A provider's connection
 * fields of kind "secret" are sealed together as one JSON object
 * (SecretPurpose.IntegrationCredentials); everything else is plain config.
 * Only `{ field: lastFour }` hints ever leave the server.
 */

/** Secrets as submitted on the wire: null keeps the stored value, "" clears it. */
export type SubmittedSecrets = Record<string, string | null>;

/** `{ [secretField]: lastFour | null }`; a key is present when the secret is set. */
export type CredentialHints = Record<string, string | null>;

const HINT_MIN_SECRET_LENGTH = 8;
const HINT_LENGTH = 4;
const INBOUND_KEY_BYTES = 24;
const MIN_SCRUB_LENGTH = 4;
const MAX_SCRUB_DEPTH = 6;
const REDACTED_MARKER = "[redacted]";

export function getSecretFieldKeys(
  fields: readonly IntegrationFieldDescriptor[]
): string[] {
  return fields
    .filter((field) => field.kind === IntegrationFieldKind.Secret)
    .map((field) => field.key);
}

/** Drops the given keys (secret fields never travel in `config`). */
export function omitKeys(
  values: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !excluded.has(key))
  );
}

/**
 * Applies submitted secrets on top of the stored ones. Only declared secret
 * fields are considered: an omitted or null value keeps the stored secret, an
 * empty string clears it, anything else replaces it. With an empty `stored`
 * object this is the create path (null and "" both mean "not set").
 */
export function mergeSecrets(
  stored: Record<string, unknown>,
  submitted: SubmittedSecrets | undefined,
  secretKeys: readonly string[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of secretKeys) {
    const next = readSubmittedSecret(submitted, key);
    if (next === null) {
      if (Object.hasOwn(stored, key)) {
        merged[key] = stored[key];
      }
    } else if (next !== "") {
      merged[key] = next;
    }
  }
  return merged;
}

/** True when the submission sets or clears at least one declared secret field. */
export function hasSecretChanges(
  submitted: SubmittedSecrets | undefined,
  secretKeys: readonly string[]
): boolean {
  return secretKeys.some((key) => readSubmittedSecret(submitted, key) !== null);
}

/** True when the submission carries a new (non-empty) value for the secret field. */
export function isSecretResubmitted(
  submitted: SubmittedSecrets | undefined,
  key: string
): boolean {
  const value = readSubmittedSecret(submitted, key);
  return value !== null && value !== "";
}

export function buildCredentialHints(
  secrets: Record<string, unknown>,
  secretKeys: readonly string[]
): CredentialHints {
  const hints: CredentialHints = {};
  for (const key of secretKeys) {
    const value = secrets[key];
    if (typeof value === "string" && value.length > 0) {
      hints[key] = toLastFour(value);
    }
  }
  return hints;
}

/** Seals the secrets object; null when there is nothing to store. */
export function sealCredentials(
  secrets: Record<string, unknown>
): string | null {
  if (Object.keys(secrets).length === 0) {
    return null;
  }
  return encryptSecret(
    JSON.stringify(secrets),
    SecretPurpose.IntegrationCredentials
  );
}

/**
 * Opens the sealed secrets object. A missing value is an empty object; a
 * value that cannot be decrypted or parsed (rotated ENCRYPTION_KEY, corrupt
 * row) is an error whose message never contains secret material.
 */
export function openCredentials(
  sealed: string | null
): Result<Record<string, unknown>, string> {
  if (!sealed) {
    return Result.ok({});
  }
  try {
    const plaintext = decryptSecret(
      sealed,
      SecretPurpose.IntegrationCredentials
    );
    const parsed = jsonObjectSchema.safeParse(JSON.parse(plaintext));
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err("Stored credentials are not a JSON object");
  } catch (error) {
    return Result.err(
      `Stored credentials could not be decrypted (${parseError(error)})`
    );
  }
}

export function sealInboundSecret(secret: string): string {
  return encryptSecret(secret, SecretPurpose.IntegrationInboundSecret);
}

export function openInboundSecret(
  sealed: string | null
): Result<string, string> {
  if (!sealed) {
    return Result.err("The connection has no inbound secret");
  }
  try {
    return Result.ok(
      decryptSecret(sealed, SecretPurpose.IntegrationInboundSecret)
    );
  } catch (error) {
    return Result.err(
      `The inbound secret could not be decrypted (${parseError(error)})`
    );
  }
}

/** Opaque, URL-safe path segment of the inbound URL (32 characters). */
export function generateInboundKey(): string {
  return randomBytes(INBOUND_KEY_BYTES).toString("base64url");
}

/** The secret strings worth scrubbing from provider-written text. */
export function collectSecretValues(
  secrets: Record<string, unknown>
): string[] {
  return Object.values(secrets).filter(
    (value): value is string =>
      typeof value === "string" && value.length >= MIN_SCRUB_LENGTH
  );
}

/** Replaces every occurrence of a known secret value with a marker. */
export function scrubSecretValues(
  text: string,
  secretValues: readonly string[]
): string {
  let scrubbed = text;
  for (const secret of secretValues) {
    scrubbed = scrubbed.replaceAll(secret, REDACTED_MARKER);
  }
  return scrubbed;
}

/** Log metadata with secret values scrubbed from every nested string. */
export function scrubLogMeta(
  meta: Record<string, unknown>,
  secretValues: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [
      key,
      scrubSecretsDeep(value, secretValues),
    ])
  );
}

/**
 * Deep copy of a value with secret values scrubbed from every string.
 * Errors are flattened to their message (their own fields are not
 * enumerable). Depth is bounded so a cyclic or huge object cannot stall a log
 * call.
 */
export function scrubSecretsDeep(
  value: unknown,
  secretValues: readonly string[],
  depth = 0
): unknown {
  if (typeof value === "string") {
    return scrubSecretValues(value, secretValues);
  }
  if (value instanceof Error) {
    return scrubSecretValues(parseError(value), secretValues);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_SCRUB_DEPTH) {
    return REDACTED_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretsDeep(item, secretValues, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scrubSecretsDeep(item, secretValues, depth + 1),
    ])
  );
}

/** null when the submission does not touch the field (omitted or null). */
function readSubmittedSecret(
  submitted: SubmittedSecrets | undefined,
  key: string
): string | null {
  if (!(submitted && Object.hasOwn(submitted, key))) {
    return null;
  }
  return submitted[key] ?? null;
}

function toLastFour(value: string): string | null {
  return value.length >= HINT_MIN_SECRET_LENGTH
    ? value.slice(-HINT_LENGTH)
    : null;
}
