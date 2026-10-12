import type { JsonObject } from "@repo/api/src/types/common";
import type { InboundEvent, IntegrationAccount } from "../../types";
import { JiraDeployment } from "./constants";
import type { JiraUser } from "./schemas";

/**
 * Jira identities: Cloud users are identified by `accountId`; Data Center
 * users by user key and user name (`key` / `name`, which change places in
 * changelogs depending on the version). These helpers build the connection's
 * bot account from `GET /myself` and recognise it in payloads.
 */

/** Keys of IntegrationAccount.details written by this provider. */
export const JiraAccountDetail = {
  Deployment: "deployment",
  TimeZone: "timeZone",
  /** Data Center user name (JQL and changelogs use it). */
  UserName: "userName",
} as const;
export type JiraAccountDetail =
  (typeof JiraAccountDetail)[keyof typeof JiraAccountDetail];

/**
 * The bot account from `GET /myself`, or null when the response lacks the
 * identifier of the configured deployment (a Cloud site configured as Data
 * Center or the other way around).
 */
export function accountFromMyself(
  user: JiraUser,
  deployment: JiraDeployment
): IntegrationAccount | null {
  const externalAccountId =
    deployment === JiraDeployment.Cloud
      ? clean(user.accountId)
      : (clean(user.key) ?? clean(user.name));
  if (!externalAccountId) {
    return null;
  }
  const aliases = uniqueValues([user.emailAddress, user.name, user.key]).filter(
    (alias) => alias !== externalAccountId
  );
  const details: JsonObject = { [JiraAccountDetail.Deployment]: deployment };
  const timeZone = clean(user.timeZone);
  if (timeZone) {
    details[JiraAccountDetail.TimeZone] = timeZone;
  }
  const userName = clean(user.name);
  if (userName) {
    details[JiraAccountDetail.UserName] = userName;
  }
  return {
    externalAccountId,
    displayName: clean(user.displayName),
    aliases,
    details,
  };
}

/**
 * True when any of the values is the bot's account id or one of its aliases
 * (case-insensitive). Display names are never matched; they are not unique.
 */
export function isJiraBotIdentity(
  account: IntegrationAccount | null,
  values: ReadonlyArray<string | null | undefined>
): boolean {
  if (!account) {
    return false;
  }
  const accountKeys = new Set(
    [account.externalAccountId, ...account.aliases].map(normalizeKey)
  );
  return uniqueValues(values).some((value) =>
    accountKeys.has(normalizeKey(value))
  );
}

/** Identifiers of a payload user that can match the bot. */
export function jiraUserIdentityValues(
  user: JiraUser | null | undefined
): Array<string | null | undefined> {
  if (!user) {
    return [];
  }
  return [user.accountId, user.key, user.name, user.emailAddress];
}

export function isJiraBotUser(
  account: IntegrationAccount | null,
  user: JiraUser | null | undefined
): boolean {
  return isJiraBotIdentity(account, jiraUserIdentityValues(user));
}

export function jiraUserActor(
  user: JiraUser | null | undefined
): InboundEvent["actor"] {
  if (!user) {
    return null;
  }
  const id = clean(user.accountId) ?? clean(user.key) ?? clean(user.name);
  return id ? { id, displayName: clean(user.displayName) } : null;
}

/** How JQL and setup instructions name the bot: Cloud account id, Data Center user name. */
export function jiraBotJqlIdentifier(account: IntegrationAccount): string {
  const userName = account.details[JiraAccountDetail.UserName];
  if (
    account.details[JiraAccountDetail.Deployment] ===
      JiraDeployment.DataCenter &&
    typeof userName === "string"
  ) {
    return userName;
  }
  return account.externalAccountId;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueValues(
  values: ReadonlyArray<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}
