import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@repo/api/src/types/common";
import type { AnyProvider } from "../registry";
import { parseConnectionConfig } from "./provider-checks";
import {
  type CredentialHints,
  getSecretFieldKeys,
  isSecretResubmitted,
  type SubmittedSecrets,
} from "./secrets";

/**
 * Stored credentials only go back to the host they were entered for. A
 * provider lists the config fields that decide where its credentials are
 * sent (`connection.credentialOriginFields`, e.g. the Jira site URL and
 * deployment). When an update changes one of them, every secret that is
 * currently set must be entered again in the same request; otherwise the
 * update is refused before the provider is called, so an edited site URL can
 * never receive the stored token.
 */

export type CredentialOriginInput = {
  provider: AnyProvider;
  storedConfig: JsonObject;
  /** Secret fields currently set (keys of the stored credential hints). */
  storedHints: CredentialHints;
  submittedConfig: Record<string, unknown> | undefined;
  submittedSecrets: SubmittedSecrets | undefined;
};

/** A user-facing message when stored secrets would follow a changed origin, else null. */
export function checkCredentialOrigin(
  input: CredentialOriginInput
): string | null {
  const changed = changedOriginFields(input);
  if (changed.length === 0) {
    return null;
  }
  const missing = getSecretFieldKeys(input.provider.connection.fields).filter(
    (key) =>
      Object.hasOwn(input.storedHints, key) &&
      !isSecretResubmitted(input.submittedSecrets, key)
  );
  if (missing.length === 0) {
    return null;
  }
  return `Re-enter ${fieldLabels(input.provider, missing)} when changing ${fieldLabels(input.provider, changed)}.`;
}

const LIST_FORMAT = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

/**
 * Origin fields whose parsed value differs from the stored one. A submitted
 * config that does not parse is rejected by validation before any provider
 * call, so it changes nothing here; a stored config that no longer parses
 * counts as changed.
 */
function changedOriginFields(input: CredentialOriginInput): string[] {
  const originKeys = input.provider.connection.credentialOriginFields ?? [];
  if (input.submittedConfig === undefined || originKeys.length === 0) {
    return [];
  }
  const next = parseConnectionConfig(input.provider, input.submittedConfig);
  if (!next.ok) {
    return [];
  }
  const current = parseConnectionConfig(input.provider, input.storedConfig);
  return originKeys.filter(
    (key) =>
      !(current.ok && isDeepStrictEqual(next.value[key], current.value[key]))
  );
}

function fieldLabels(provider: AnyProvider, keys: readonly string[]): string {
  const labels = keys.map(
    (key) =>
      provider.connection.fields.find((field) => field.key === key)?.label ??
      key
  );
  return LIST_FORMAT.format(labels);
}
