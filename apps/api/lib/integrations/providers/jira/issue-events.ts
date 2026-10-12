import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import type {
  InboundEvent,
  InboundEventAttributeValue,
  IntegrationAccount,
  SourceItemRef,
} from "../../types";
import { jiraIssueBrowseUrl } from "./client";
import {
  JiraChangelogField,
  JiraEventAttribute,
  JiraTriggerType,
} from "./constants";
import { isJiraBotIdentity } from "./identity";
import { descriptionMentionsBot, mentionsJiraBot } from "./mentions";
import type { JiraChangeItem, JiraIssue } from "./schemas";

/**
 * Builds normalized InboundEvents from Jira issue data. Webhook parsing,
 * polling and manual runs all go through here, so an occurrence gets the
 * same dedupKey whichever way it arrives:
 *   assigned to the bot by a change -> "{key}:assignee:{changelogId}"
 *   labels added by a change         -> "{key}:labels:{changelogId}"
 *   created assigned to the bot / with labels / mentioning it -> "{key}:created"
 *   description edited to mention the bot -> "{key}:mention:{changelogId}"
 *   comment mentioning the bot       -> "{key}:mention:comment-{commentId}"
 *   manual run                       -> "{key}:manual"
 */

export const JiraDedupKind = {
  Assignee: "assignee",
  Labels: "labels",
  Created: "created",
  Mention: "mention",
  Manual: "manual",
} as const;
export type JiraDedupKind = (typeof JiraDedupKind)[keyof typeof JiraDedupKind];

/** One occurrence on one issue: the issue state, when and by whom. */
export type JiraIssueOccurrence = {
  siteUrl: string;
  issue: JiraIssue;
  occurredAt: Date;
  actor: InboundEvent["actor"];
};

export function jiraItemRef(siteUrl: string, issue: JiraIssue): SourceItemRef {
  return {
    provider: IntegrationProviderKey.Jira,
    externalId: issue.id,
    key: issue.key,
    url: jiraIssueBrowseUrl(siteUrl, issue.key),
    title: issue.fields.summary ?? null,
    container: issue.fields.project?.key ?? projectKeyOf(issue.key),
  };
}

/** Values trigger filters match on. */
export function jiraIssueAttributes(
  issue: JiraIssue
): Record<string, InboundEventAttributeValue> {
  return {
    [JiraEventAttribute.ProjectKey]:
      issue.fields.project?.key ?? projectKeyOf(issue.key),
    [JiraEventAttribute.IssueType]: issue.fields.issuetype?.name ?? null,
    [JiraEventAttribute.Labels]: issue.fields.labels ?? [],
    [JiraEventAttribute.Status]: issue.fields.status?.name ?? null,
  };
}

/** `changeId` null means the issue was created assigned to the bot. */
export function jiraAssignedEvent(
  occurrence: JiraIssueOccurrence,
  changeId: string | null
): InboundEvent {
  return {
    triggerType: JiraTriggerType.IssueAssigned,
    dedupKey: changeId
      ? jiraDedupKey(occurrence.issue.key, JiraDedupKind.Assignee, changeId)
      : jiraDedupKey(occurrence.issue.key, JiraDedupKind.Created),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: jiraIssueAttributes(occurrence.issue),
  };
}

/** `changeId` null means the issue was created with these labels. */
export function jiraLabeledEvent(
  occurrence: JiraIssueOccurrence,
  addedLabels: string[],
  changeId: string | null
): InboundEvent {
  return {
    triggerType: JiraTriggerType.IssueLabeled,
    dedupKey: changeId
      ? jiraDedupKey(occurrence.issue.key, JiraDedupKind.Labels, changeId)
      : jiraDedupKey(occurrence.issue.key, JiraDedupKind.Created),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: {
      ...jiraIssueAttributes(occurrence.issue),
      [JiraEventAttribute.AddedLabels]: addedLabels,
    },
  };
}

/** Event for a manual run; a label trigger treats every current label as added. */
export function jiraManualEvent(
  occurrence: JiraIssueOccurrence,
  triggerType: JiraTriggerType
): InboundEvent {
  const attributes = jiraIssueAttributes(occurrence.issue);
  if (triggerType === JiraTriggerType.IssueLabeled) {
    attributes[JiraEventAttribute.AddedLabels] =
      occurrence.issue.fields.labels ?? [];
  }
  return {
    triggerType,
    dedupKey: jiraDedupKey(occurrence.issue.key, JiraDedupKind.Manual),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes,
  };
}

/** Events of one changelog entry (a jira:issue_updated webhook or a polled history). */
export function jiraChangeEvents(
  occurrence: JiraIssueOccurrence,
  items: readonly JiraChangeItem[],
  changeId: string,
  account: IntegrationAccount
): InboundEvent[] {
  const events: InboundEvent[] = [];
  if (items.some((item) => assignsToBot(item, account))) {
    events.push(jiraAssignedEvent(occurrence, changeId));
  }
  const added = uniqueStrings(
    items.filter(isLabelsChange).flatMap((item) => addedLabels(item))
  );
  if (added.length > 0) {
    events.push(jiraLabeledEvent(occurrence, added, changeId));
  }
  if (descriptionMentionsBot(items, account)) {
    events.push(jiraMentionedEvent(occurrence, changeId));
  }
  return events;
}

/** Events of a jira:issue_created webhook: assigned to the bot, and/or created with labels. */
export function jiraCreatedEvents(
  occurrence: JiraIssueOccurrence,
  account: IntegrationAccount
): InboundEvent[] {
  const events: InboundEvent[] = [];
  if (isAssignedToBot(occurrence.issue, account)) {
    events.push(jiraAssignedEvent(occurrence, null));
  }
  const labels = uniqueStrings(occurrence.issue.fields.labels ?? []);
  if (labels.length > 0) {
    events.push(jiraLabeledEvent(occurrence, labels, null));
  }
  if (mentionsJiraBot(occurrence.issue.fields.description, account)) {
    events.push(jiraMentionedEvent(occurrence, null));
  }
  return events;
}

/** `changeId` null means the issue was created with a description that mentions the bot. */
export function jiraMentionedEvent(
  occurrence: JiraIssueOccurrence,
  changeId: string | null
): InboundEvent {
  return {
    triggerType: JiraTriggerType.IssueMentioned,
    dedupKey: changeId
      ? jiraDedupKey(occurrence.issue.key, JiraDedupKind.Mention, changeId)
      : jiraDedupKey(occurrence.issue.key, JiraDedupKind.Created),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: jiraIssueAttributes(occurrence.issue),
  };
}

/** A comment_created / comment_updated webhook whose comment mentions the bot. */
export function jiraCommentMentionEvents(
  occurrence: JiraIssueOccurrence,
  comment: { id: string; body?: unknown },
  account: IntegrationAccount
): InboundEvent[] {
  if (!mentionsJiraBot(comment.body, account)) {
    return [];
  }
  return [jiraMentionedEvent(occurrence, `comment-${comment.id}`)];
}

export function isAssignedToBot(
  issue: JiraIssue,
  account: IntegrationAccount
): boolean {
  const assignee = issue.fields.assignee;
  if (!assignee) {
    return false;
  }
  return isJiraBotIdentity(account, [
    assignee.accountId,
    assignee.key,
    assignee.name,
  ]);
}

export function isAssigneeChange(item: JiraChangeItem): boolean {
  return changedField(item) === JiraChangelogField.Assignee;
}

export function isLabelsChange(item: JiraChangeItem): boolean {
  return changedField(item) === JiraChangelogField.Labels;
}

/**
 * The change assigns the issue to the bot. Cloud webhooks carry the account
 * id in `tmpToAccountId` (`to` may hold a display name for REST-made
 * changes); REST changelogs carry it in `to`; Data Center uses the user name
 * or key in `to`.
 */
export function assignsToBot(
  item: JiraChangeItem,
  account: IntegrationAccount
): boolean {
  return (
    isAssigneeChange(item) &&
    isJiraBotIdentity(account, [item.tmpToAccountId, item.to])
  );
}

/** The change moves the issue away from the bot (its old assignee was the bot). */
export function assignsFromBot(
  item: JiraChangeItem,
  account: IntegrationAccount
): boolean {
  return (
    isAssigneeChange(item) &&
    isJiraBotIdentity(account, [item.tmpFromAccountId, item.from])
  );
}

/** Labels present after the change but not before (labels are space-separated in changelogs). */
export function addedLabels(item: JiraChangeItem): string[] {
  const before = new Set(labelTokens(item.fromText ?? item.from));
  return labelTokens(item.toText ?? item.to).filter(
    (label) => !before.has(label)
  );
}

export function jiraDedupKey(
  issueKey: string,
  kind: JiraDedupKind,
  changeId?: string
): string {
  return changeId ? `${issueKey}:${kind}:${changeId}` : `${issueKey}:${kind}`;
}

const WHITESPACE_RE = /\s+/;

function changedField(item: JiraChangeItem): string {
  return (item.fieldId ?? item.field ?? "").trim().toLowerCase();
}

function labelTokens(value: string | null | undefined): string[] {
  return (value ?? "").split(WHITESPACE_RE).filter((token) => token !== "");
}

function projectKeyOf(issueKey: string): string | null {
  const separator = issueKey.lastIndexOf("-");
  return separator > 0 ? issueKey.slice(0, separator) : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
