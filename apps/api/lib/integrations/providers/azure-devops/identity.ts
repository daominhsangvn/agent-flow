import type { InboundEvent, IntegrationAccount } from "../../types";
import { adoIdentityRefSchema } from "./schemas";

/**
 * Azure DevOps identities arrive in several shapes depending on the API and
 * payload version: an IdentityRef object `{id, uniqueName, displayName,
 * descriptor}` (REST 7.x, service hook `revisedBy`), a `"Display Name
 * <email>"` string (older service hook field values), a bare email/UPN, a
 * `DOMAIN\user` name, or an identity GUID. These helpers normalize all of
 * them and recognise the connection's bot account.
 */

export type AdoIdentity = {
  id: string | null;
  uniqueName: string | null;
  displayName: string | null;
  descriptor: string | null;
};

export function parseAdoIdentity(value: unknown): AdoIdentity | null {
  if (typeof value === "string") {
    return parseIdentityString(value);
  }
  const parsed = adoIdentityRefSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const fromName = parsed.data.name
    ? parseIdentityString(parsed.data.name)
    : null;
  const identity: AdoIdentity = {
    id: clean(parsed.data.id),
    uniqueName: clean(parsed.data.uniqueName) ?? fromName?.uniqueName ?? null,
    displayName:
      clean(parsed.data.displayName) ?? fromName?.displayName ?? null,
    descriptor: clean(parsed.data.descriptor),
  };
  return hasAnyValue(identity) ? identity : null;
}

/**
 * True when the identity is the connection's bot account: its id, unique
 * name or descriptor equals the account id or one of its aliases
 * (case-insensitive). Display names are never matched; they are not unique.
 */
export function isAdoBotIdentity(
  value: unknown,
  account: IntegrationAccount | null
): boolean {
  if (!account) {
    return false;
  }
  const identity = parseAdoIdentity(value);
  if (!identity) {
    return false;
  }
  const accountKeys = new Set(
    [account.externalAccountId, ...account.aliases].map((key) =>
      key.trim().toLowerCase()
    )
  );
  return [identity.id, identity.uniqueName, identity.descriptor].some(
    (key) => key !== null && accountKeys.has(key.toLowerCase())
  );
}

/** Human-readable name of an identity value, or null. */
export function adoIdentityLabel(value: unknown): string | null {
  const identity = parseAdoIdentity(value);
  if (!identity) {
    return null;
  }
  return identity.displayName ?? identity.uniqueName ?? identity.id;
}

/** The identity's email: its unique name when that is one (Entra ID accounts). */
export function adoIdentityEmail(value: unknown): string | null {
  const uniqueName = parseAdoIdentity(value)?.uniqueName ?? null;
  return uniqueName?.includes("@") ? uniqueName : null;
}

/** InboundEvent actor for an identity value, or null when it carries nothing usable. */
export function adoIdentityActor(value: unknown): InboundEvent["actor"] {
  const identity = parseAdoIdentity(value);
  if (!identity) {
    return null;
  }
  const id = identity.id ?? identity.uniqueName ?? identity.displayName;
  return id ? { id, displayName: identity.displayName } : null;
}

const NAME_WITH_EMAIL_RE = /^(.*?)\s*<([^<>]+)>\s*$/;
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIdentityString(raw: string): AdoIdentity | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const withEmail = NAME_WITH_EMAIL_RE.exec(value);
  if (withEmail) {
    return {
      id: null,
      uniqueName: clean(withEmail[2]),
      displayName: clean(withEmail[1]),
      descriptor: null,
    };
  }
  if (GUID_RE.test(value)) {
    return { id: value, uniqueName: null, displayName: null, descriptor: null };
  }
  if (value.includes("@") || value.includes("\\")) {
    return { id: null, uniqueName: value, displayName: null, descriptor: null };
  }
  return { id: null, uniqueName: null, displayName: value, descriptor: null };
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function hasAnyValue(identity: AdoIdentity): boolean {
  return Boolean(
    identity.id ??
      identity.uniqueName ??
      identity.displayName ??
      identity.descriptor
  );
}
