import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import type {
  InboundEvent,
  InboundEventAttributeValue,
  InboundItemChange,
  IntegrationAccount,
  SourceItemRef,
} from "../../types";
import { jiraIssueBrowseUrl } from "./client";
import {
  JiraChangelogField,
  JiraEventAttribute,
  JiraSignalType,
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
 *   labels added or removed by a change -> "{key}:labels:{changelogId}"
 *   status changed by a change       -> "{key}:status:{changelogId}"
 *   created assigned to the bot / with labels / mentioning it -> "{key}:created"
 *   description edited to mention the bot -> "{key}:mention:{changelogId}"
 *   comment mentioning the bot       -> "{key}:mention:comment-{commentId}"
 *   reply in a comment thread        -> "{key}:reply:{commentId}" (jira.comment_reply)
 *   manual run                       -> "{key}:manual"
 *
 * Every occurrence that assigns the issue to the bot, adds labels or
 * mentions the bot also yields one jira.issue_conditions event
 * ("{key}:conditions:{changelogId | created | comment-{commentId}}") that
 * carries all three facts and the issue state after the occurrence, so a
 * conditions trigger can combine them.
 */

export const JiraDedupKind = {
  Assignee: "assignee",
  Labels: "labels",
  Status: "status",
  Created: "created",
  Mention: "mention",
  Conditions: "conditions",
  Reply: "reply",
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
  labels: { added: string[]; removed: string[] },
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
      [JiraEventAttribute.AddedLabels]: labels.added,
      [JiraEventAttribute.RemovedLabels]: labels.removed,
    },
    itemChange: { labels },
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
  const assigned = items.some((item) => assignsToBot(item, account));
  if (assigned) {
    events.push(jiraAssignedEvent(occurrence, changeId));
  }
  const { added } = labelChangesOf(items);
  events.push(...itemChangeEvents(occurrence, items, changeId));
  const mentioned = descriptionMentionsBot(items, account);
  if (mentioned) {
    events.push(jiraMentionedEvent(occurrence, changeId));
  }
  return withConditionsEvent(events, {
    occurrence,
    facts: { becameAssigned: assigned, addedLabels: added, mentioned },
    state: jiraIssueState(occurrence.issue, account),
    changeId,
  });
}

/** Events of a jira:issue_created webhook: assigned to the bot, and/or created with labels. */
export function jiraCreatedEvents(
  occurrence: JiraIssueOccurrence,
  account: IntegrationAccount
): InboundEvent[] {
  const events: InboundEvent[] = [];
  const assigned = isAssignedToBot(occurrence.issue, account);
  if (assigned) {
    events.push(jiraAssignedEvent(occurrence, null));
  }
  const labels = uniqueStrings(occurrence.issue.fields.labels ?? []);
  if (labels.length > 0) {
    events.push(
      jiraLabeledEvent(occurrence, { added: labels, removed: [] }, null)
    );
  }
  const mentioned = mentionsJiraBot(
    occurrence.issue.fields.description,
    account
  );
  if (mentioned) {
    events.push(jiraMentionedEvent(occurrence, null));
  }
  return withConditionsEvent(events, {
    occurrence,
    facts: { becameAssigned: assigned, addedLabels: labels, mentioned },
    state: { assignedToBot: assigned, labels },
    changeId: null,
  });
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

/**
 * A comment_created / comment_updated webhook whose comment mentions the bot.
 * `occurrence.issue` should be the issue as REST returns it: the issue of a
 * comment webhook lacks fields such as the labels.
 */
export function jiraCommentMentionEvents(
  occurrence: JiraIssueOccurrence,
  comment: { id: string; body?: unknown },
  account: IntegrationAccount
): InboundEvent[] {
  if (!mentionsJiraBot(comment.body, account)) {
    return [];
  }
  const changeId = `comment-${comment.id}`;
  return withConditionsEvent([jiraMentionedEvent(occurrence, changeId)], {
    occurrence,
    facts: { becameAssigned: false, addedLabels: [], mentioned: true },
    state: jiraIssueState(occurrence.issue, account),
    changeId,
  });
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

/** Labels present before the change but not after (the mirror of addedLabels). */
export function removedLabels(item: JiraChangeItem): string[] {
  const after = new Set(labelTokens(item.toText ?? item.to));
  return labelTokens(item.fromText ?? item.from).filter(
    (label) => !after.has(label)
  );
}

export function isStatusChange(item: JiraChangeItem): boolean {
  return changedField(item) === JiraChangelogField.Status;
}

/** The first status change of the items (status names, not ids), else null. */
export function statusChangeOf(
  items: readonly JiraChangeItem[]
): { from: string | null; to: string | null } | null {
  const item = items.find(isStatusChange);
  if (!item) {
    return null;
  }
  return { from: item.fromText ?? null, to: item.toText ?? null };
}

/** Labels added and removed by the labels items of one changelog entry. */
export function labelChangesOf(items: readonly JiraChangeItem[]): {
  added: string[];
  removed: string[];
} {
  const labelItems = items.filter(isLabelsChange);
  return {
    added: uniqueStrings(labelItems.flatMap((item) => addedLabels(item))),
    removed: uniqueStrings(labelItems.flatMap((item) => removedLabels(item))),
  };
}

/** The status and label events of one changelog entry (not the conditions fact events). */
export function itemChangeEvents(
  occurrence: JiraIssueOccurrence,
  items: readonly JiraChangeItem[],
  changeId: string
): InboundEvent[] {
  const events: InboundEvent[] = [];
  const status = statusChangeOf(items);
  if (status) {
    events.push(jiraStatusChangedEvent(occurrence, status, changeId));
  }
  const labels = labelChangesOf(items);
  if (labels.added.length > 0 || labels.removed.length > 0) {
    events.push(jiraLabeledEvent(occurrence, labels, changeId));
  }
  return events;
}

export function jiraStatusChangedEvent(
  occurrence: JiraIssueOccurrence,
  change: { from: string | null; to: string | null },
  changeId: string
): InboundEvent {
  const itemChange: InboundItemChange = { status: change };
  return {
    triggerType: JiraTriggerType.IssueStatusChanged,
    dedupKey: jiraDedupKey(
      occurrence.issue.key,
      JiraDedupKind.Status,
      changeId
    ),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: {
      ...jiraIssueAttributes(occurrence.issue),
      [JiraEventAttribute.FromStatus]: change.from,
      [JiraEventAttribute.ToStatus]: change.to,
    },
    itemChange,
  };
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

/** Labels of a changelog value (space-separated). */
export function labelTokens(value: string | null | undefined): string[] {
  return (value ?? "").split(WHITESPACE_RE).filter((token) => token !== "");
}

function projectKeyOf(issueKey: string): string | null {
  const separator = issueKey.lastIndexOf("-");
  return separator > 0 ? issueKey.slice(0, separator) : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** `events` plus the occurrence's jira.issue_conditions event, when it has facts. */
function withConditionsEvent(
  events: InboundEvent[],
  input: Parameters<typeof jiraConditionsEvent>[0]
): InboundEvent[] {
  return hasConditionFacts(input.facts)
    ? [...events, jiraConditionsEvent(input)]
    : events;
}

/** What an occurrence did, as jira.issue_conditions triggers see it. */
export type JiraConditionFacts = {
  /** The occurrence assigned the issue to the bot (or created it assigned). */
  becameAssigned: boolean;
  /** Labels the occurrence added (all labels for a creation). */
  addedLabels: string[];
  /** The occurrence is a mention of the bot. */
  mentioned: boolean;
};

/** The condition-relevant state of an issue right after an occurrence. */
export type JiraIssueState = {
  assignedToBot: boolean;
  labels: string[];
};

/**
 * The jira.issue_conditions event of an occurrence. `changeId` null means
 * the issue was created (dedupKey "{key}:conditions:created").
 */
export function jiraConditionsEvent(input: {
  occurrence: JiraIssueOccurrence;
  facts: JiraConditionFacts;
  state: JiraIssueState;
  changeId: string | null;
}): InboundEvent {
  const { occurrence, facts, state } = input;
  return {
    triggerType: JiraTriggerType.IssueConditions,
    dedupKey: jiraDedupKey(
      occurrence.issue.key,
      JiraDedupKind.Conditions,
      input.changeId ?? JiraDedupKind.Created
    ),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: {
      ...jiraIssueAttributes(occurrence.issue),
      [JiraEventAttribute.Labels]: state.labels,
      [JiraEventAttribute.AssignedToBot]: state.assignedToBot,
      [JiraEventAttribute.BecameAssigned]: facts.becameAssigned,
      [JiraEventAttribute.AddedLabels]: facts.addedLabels,
      [JiraEventAttribute.Mentioned]: facts.mentioned,
    },
  };
}

/** The issue's assignee (the bot or not) and labels as the issue data shows them. */
export function jiraIssueState(
  issue: JiraIssue,
  account: IntegrationAccount
): JiraIssueState {
  return {
    assignedToBot: isAssignedToBot(issue, account),
    labels: uniqueStrings(issue.fields.labels ?? []),
  };
}

/** True when the facts make a jira.issue_conditions event worth emitting. */
export function hasConditionFacts(facts: JiraConditionFacts): boolean {
  return (
    facts.becameAssigned || facts.addedLabels.length > 0 || facts.mentioned
  );
}

/** A comment_created webhook whose comment replies to another comment. */
export function jiraCommentReplyEvent(
  occurrence: JiraIssueOccurrence,
  comment: { id: string; parentId: string }
): InboundEvent {
  return {
    triggerType: JiraSignalType.CommentReply,
    dedupKey: jiraDedupKey(
      occurrence.issue.key,
      JiraDedupKind.Reply,
      comment.id
    ),
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: jiraItemRef(occurrence.siteUrl, occurrence.issue),
    attributes: {
      ...jiraIssueAttributes(occurrence.issue),
      [JiraEventAttribute.RepliedTo]: comment.parentId,
    },
  };
}

/** The comment a jira.comment_reply event replies to (the provider's answerReply hook). */
export function jiraAnswerReply(event: InboundEvent): string | null {
  if (event.triggerType !== JiraSignalType.CommentReply) {
    return null;
  }
  const repliedTo = event.attributes[JiraEventAttribute.RepliedTo];
  return typeof repliedTo === "string" ? repliedTo : null;
}
