import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import type {
  InboundEvent,
  InboundEventAttributeValue,
  IntegrationAccount,
  SourceItemRef,
} from "../../types";
import { workItemWebUrl } from "./client";
import {
  AdoEventAttribute,
  AdoField,
  AdoIgnoredReason,
  AzureDevOpsTriggerType,
} from "./constants";
import { adoIdentityActor, isAdoBotIdentity } from "./identity";
import type {
  AdoWorkItem,
  AdoWorkItemFields,
  AdoWorkItemUpdate,
} from "./schemas";
import { readWorkItemFields } from "./schemas";

/**
 * Builds normalized InboundEvents from Azure DevOps work item data. Webhook
 * parsing, polling and manual runs all go through here, so an occurrence gets
 * the same dedupKey whichever way it arrives:
 *   assigned to the bot  -> "{id}:rev:{rev}"
 *   tags added           -> "{id}:tags:{rev}"
 *   bot mentioned        -> "{id}:mention:{rev}" (a comment, or the
 *                           description of a new work item, mentions it)
 *   any of the three     -> "{id}:conditions:{rev}" (one
 *                           work_item_conditions event carrying all three
 *                           facts and the work item state after the change)
 */

export type WorkItemOccurrence = {
  organizationUrl: string;
  workItemId: number;
  rev: number;
  /** Work item fields at (or after) this revision; used for the item ref and filter attributes. */
  fields: AdoWorkItemFields;
  /** Project (id) to use when the fields carry no System.TeamProject. */
  projectFallback: string | null;
  actor: InboundEvent["actor"];
  occurredAt: Date;
};

export type OccurrenceEvents = {
  events: InboundEvent[];
  /** Set when no event was produced. */
  ignoredReason: AdoIgnoredReason | null;
};

export type UpdateEventsInput = {
  organizationUrl: string;
  workItemId: number;
  update: AdoWorkItemUpdate;
  fields: AdoWorkItemFields;
  projectFallback: string | null;
  account: IntegrationAccount;
  /** Used when the update carries no System.ChangedDate. */
  occurredAtFallback: Date;
  /**
   * Assignee and tags right after the update. Defaults to the update's new
   * values, else `fields` (a service hook's revision snapshot); polling,
   * whose `fields` are the current ones, passes the state replayed from the
   * updates.
   */
  state?: AdoWorkItemState;
};

export type CreatedEventsInput = {
  organizationUrl: string;
  workItem: AdoWorkItem;
  projectFallback: string | null;
  account: IntegrationAccount;
  occurredAtFallback: Date;
};

/** Events for one WorkItemUpdate (a `workitem.updated` resource or a REST `updates` entry). */
export function eventsFromWorkItemUpdate(
  input: UpdateEventsInput
): OccurrenceEvents {
  const { update, account } = input;
  const changedBy =
    update.revisedBy ?? update.fields?.[AdoField.ChangedBy]?.newValue;
  if (isAdoBotIdentity(changedBy, account)) {
    return { events: [], ignoredReason: AdoIgnoredReason.CausedByBot };
  }
  const rev = update.rev ?? update.revision?.rev ?? null;
  if (rev === null) {
    return { events: [], ignoredReason: AdoIgnoredReason.InvalidPayload };
  }
  const occurrence: WorkItemOccurrence = {
    organizationUrl: input.organizationUrl,
    workItemId: input.workItemId,
    rev,
    fields: input.fields,
    projectFallback: input.projectFallback,
    actor: adoIdentityActor(changedBy),
    occurredAt:
      parseAdoDate(update.fields?.[AdoField.ChangedDate]?.newValue) ??
      input.occurredAtFallback,
  };
  const events: InboundEvent[] = [];
  const assignedTo = update.fields?.[AdoField.AssignedTo];
  const assigned = Boolean(
    assignedTo && isAdoBotIdentity(assignedTo.newValue, account)
  );
  if (assigned) {
    events.push(workItemAssignedEvent(occurrence));
  }
  const tags = update.fields?.[AdoField.Tags];
  const addedTags = tags ? addedAdoTags(tags.oldValue, tags.newValue) : [];
  if (addedTags.length > 0) {
    events.push(workItemTaggedEvent(occurrence, addedTags));
  }
  const mentioned = mentionsAdoBot(
    update.fields?.[AdoField.History]?.newValue,
    account
  );
  if (mentioned) {
    events.push(workItemMentionedEvent(occurrence));
  }
  return withIgnoredReason(
    withConditionsEvent(events, {
      occurrence,
      facts: { becameAssigned: assigned, addedTags, mentioned },
      state: input.state ?? stateAfterUpdate(update, input.fields, account),
    })
  );
}

/** Events for a `workitem.created` resource (the full work item). */
export function eventsFromCreatedWorkItem(
  input: CreatedEventsInput
): OccurrenceEvents {
  const { workItem, account } = input;
  const fields = readWorkItemFields(workItem.fields);
  const createdBy = fields[AdoField.CreatedBy];
  if (isAdoBotIdentity(createdBy, account)) {
    return { events: [], ignoredReason: AdoIgnoredReason.CausedByBot };
  }
  const occurrence: WorkItemOccurrence = {
    organizationUrl: input.organizationUrl,
    workItemId: workItem.id,
    rev: workItem.rev ?? 1,
    fields,
    projectFallback: input.projectFallback,
    actor: adoIdentityActor(createdBy),
    occurredAt:
      parseAdoDate(fields[AdoField.CreatedDate]) ?? input.occurredAtFallback,
  };
  const events: InboundEvent[] = [];
  const assigned = isAdoBotIdentity(fields[AdoField.AssignedTo], account);
  if (assigned) {
    events.push(workItemAssignedEvent(occurrence));
  }
  const tags = splitAdoTags(fields[AdoField.Tags]);
  if (tags.length > 0) {
    events.push(workItemTaggedEvent(occurrence, tags));
  }
  const mentioned =
    mentionsAdoBot(fields[AdoField.Description], account) ||
    mentionsAdoBot(fields[AdoField.History], account);
  if (mentioned) {
    events.push(workItemMentionedEvent(occurrence));
  }
  return withIgnoredReason(
    withConditionsEvent(events, {
      occurrence,
      facts: { becameAssigned: assigned, addedTags: tags, mentioned },
      state: { assignedToBot: assigned, tags },
    })
  );
}

/**
 * Events for a `workitem.commented` resource: the full work item, with the
 * new comment in System.History.
 */
export function eventsFromCommentedWorkItem(
  input: CreatedEventsInput
): OccurrenceEvents {
  const { workItem, account } = input;
  const fields = readWorkItemFields(workItem.fields);
  const changedBy = fields[AdoField.ChangedBy];
  if (isAdoBotIdentity(changedBy, account)) {
    return { events: [], ignoredReason: AdoIgnoredReason.CausedByBot };
  }
  if (!mentionsAdoBot(fields[AdoField.History], account)) {
    return { events: [], ignoredReason: AdoIgnoredReason.NoRelevantChange };
  }
  const occurrence: WorkItemOccurrence = {
    organizationUrl: input.organizationUrl,
    workItemId: workItem.id,
    rev: workItem.rev ?? 1,
    fields,
    projectFallback: input.projectFallback,
    actor: adoIdentityActor(changedBy),
    occurredAt:
      parseAdoDate(fields[AdoField.ChangedDate]) ?? input.occurredAtFallback,
  };
  return withIgnoredReason(
    withConditionsEvent([workItemMentionedEvent(occurrence)], {
      occurrence,
      facts: { becameAssigned: false, addedTags: [], mentioned: true },
      state: adoWorkItemState(fields, account),
    })
  );
}

/**
 * True when the HTML (a comment or a description) mentions the bot account.
 * Azure DevOps renders mentions as
 * `<a href="#" data-vss-mention="version:2.0,{identity id}">@Name</a>`.
 */
export function mentionsAdoBot(
  html: unknown,
  account: IntegrationAccount
): boolean {
  if (typeof html !== "string" || !html.includes(MENTION_ATTRIBUTE)) {
    return false;
  }
  const botId = account.externalAccountId.toLowerCase();
  for (const match of html.matchAll(MENTION_RE)) {
    if (match[1]?.toLowerCase() === botId) {
      return true;
    }
  }
  return false;
}

export function workItemAssignedEvent(
  occurrence: WorkItemOccurrence
): InboundEvent {
  return buildEvent(
    occurrence,
    AzureDevOpsTriggerType.WorkItemAssigned,
    `${occurrence.workItemId}:rev:${occurrence.rev}`,
    {}
  );
}

export function workItemTaggedEvent(
  occurrence: WorkItemOccurrence,
  addedTags: string[]
): InboundEvent {
  return buildEvent(
    occurrence,
    AzureDevOpsTriggerType.WorkItemTagged,
    `${occurrence.workItemId}:tags:${occurrence.rev}`,
    { [AdoEventAttribute.AddedTags]: addedTags }
  );
}

export function workItemMentionedEvent(
  occurrence: WorkItemOccurrence
): InboundEvent {
  return buildEvent(
    occurrence,
    AzureDevOpsTriggerType.WorkItemMentioned,
    `${occurrence.workItemId}:mention:${occurrence.rev}`,
    {}
  );
}

export function workItemRef(
  organizationUrl: string,
  workItemId: number,
  fields: AdoWorkItemFields,
  projectFallback: string | null
): SourceItemRef {
  const project = fields[AdoField.TeamProject] ?? projectFallback;
  return {
    provider: IntegrationProviderKey.AzureDevOps,
    externalId: String(workItemId),
    key: `#${workItemId}`,
    url: workItemWebUrl(organizationUrl, project, workItemId),
    title: fields[AdoField.Title],
    container: project,
  };
}

/** Values trigger filters match on. */
export function workItemAttributes(
  fields: AdoWorkItemFields,
  projectFallback: string | null
): Record<string, InboundEventAttributeValue> {
  return {
    [AdoEventAttribute.Project]:
      fields[AdoField.TeamProject] ?? projectFallback,
    [AdoEventAttribute.WorkItemType]: fields[AdoField.WorkItemType],
    [AdoEventAttribute.AreaPath]: fields[AdoField.AreaPath],
    [AdoEventAttribute.Tags]: splitAdoTags(fields[AdoField.Tags]),
    [AdoEventAttribute.State]: fields[AdoField.State],
  };
}

/** `"ai; Needs Review"` -> `["ai", "Needs Review"]` (trimmed, de-duplicated case-insensitively). */
export function splitAdoTags(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const token of value.split(TAG_SEPARATOR)) {
    const tag = token.trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

/** Tags present in `newValue` but not in `oldValue` (case-insensitive). */
export function addedAdoTags(oldValue: unknown, newValue: unknown): string[] {
  const previous = new Set(
    splitAdoTags(oldValue).map((tag) => tag.toLowerCase())
  );
  return splitAdoTags(newValue).filter(
    (tag) => !previous.has(tag.toLowerCase())
  );
}

/**
 * Parses an ADO timestamp. ADO uses 0001-01-01 and 9999-01-01 as "unset" and
 * "current revision" sentinels; both are treated as missing.
 */
export function parseAdoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (
    Number.isNaN(date.getTime()) ||
    year <= MIN_REAL_YEAR ||
    year >= MAX_REAL_YEAR
  ) {
    return null;
  }
  return date;
}

const TAG_SEPARATOR = ";";
const MENTION_ATTRIBUTE = "data-vss-mention";
const MENTION_RE = /data-vss-mention="version:[\d.]+,([0-9a-fA-F-]{36})"/g;
const MIN_REAL_YEAR = 1;
const MAX_REAL_YEAR = 9999;

function buildEvent(
  occurrence: WorkItemOccurrence,
  triggerType: AzureDevOpsTriggerType,
  dedupKey: string,
  extraAttributes: Record<string, InboundEventAttributeValue>
): InboundEvent {
  return {
    triggerType,
    dedupKey,
    occurredAt: occurrence.occurredAt,
    actor: occurrence.actor,
    item: workItemRef(
      occurrence.organizationUrl,
      occurrence.workItemId,
      occurrence.fields,
      occurrence.projectFallback
    ),
    attributes: {
      ...workItemAttributes(occurrence.fields, occurrence.projectFallback),
      ...extraAttributes,
    },
  };
}

function withIgnoredReason(events: InboundEvent[]): OccurrenceEvents {
  return {
    events,
    ignoredReason: events.length > 0 ? null : AdoIgnoredReason.NoRelevantChange,
  };
}

/** What a change did, as work_item_conditions triggers see it. */
export type AdoConditionFacts = {
  /** The change assigned the work item to the bot (or created it assigned). */
  becameAssigned: boolean;
  /** Tags the change added (all tags for a creation). */
  addedTags: string[];
  /** The change is a mention of the bot. */
  mentioned: boolean;
};

/** The condition-relevant state of a work item right after a change. */
export type AdoWorkItemState = {
  assignedToBot: boolean;
  tags: string[];
};

/** The work_item_conditions event of a change ("{id}:conditions:{rev}"). */
export function workItemConditionsEvent(input: {
  occurrence: WorkItemOccurrence;
  facts: AdoConditionFacts;
  state: AdoWorkItemState;
}): InboundEvent {
  const { occurrence, facts, state } = input;
  return buildEvent(
    occurrence,
    AzureDevOpsTriggerType.WorkItemConditions,
    `${occurrence.workItemId}:conditions:${occurrence.rev}`,
    {
      [AdoEventAttribute.Tags]: state.tags,
      [AdoEventAttribute.AssignedToBot]: state.assignedToBot,
      [AdoEventAttribute.BecameAssigned]: facts.becameAssigned,
      [AdoEventAttribute.AddedTags]: facts.addedTags,
      [AdoEventAttribute.Mentioned]: facts.mentioned,
    }
  );
}

/** Assignee (the bot or not) and tags of a work item's fields. */
export function adoWorkItemState(
  fields: AdoWorkItemFields,
  account: IntegrationAccount
): AdoWorkItemState {
  return {
    assignedToBot: isAdoBotIdentity(fields[AdoField.AssignedTo], account),
    tags: splitAdoTags(fields[AdoField.Tags]),
  };
}

/** `events` plus the change's work_item_conditions event, when it did something a condition reacts to. */
function withConditionsEvent(
  events: InboundEvent[],
  input: Parameters<typeof workItemConditionsEvent>[0]
): InboundEvent[] {
  const { facts } = input;
  const relevant =
    facts.becameAssigned || facts.addedTags.length > 0 || facts.mentioned;
  return relevant ? [...events, workItemConditionsEvent(input)] : events;
}

/** The update's new assignee and tags, else the snapshot's (unchanged fields). */
function stateAfterUpdate(
  update: AdoWorkItemUpdate,
  fields: AdoWorkItemFields,
  account: IntegrationAccount
): AdoWorkItemState {
  const snapshot = adoWorkItemState(fields, account);
  const assignedTo = update.fields?.[AdoField.AssignedTo];
  const tags = update.fields?.[AdoField.Tags];
  return {
    assignedToBot: assignedTo
      ? isAdoBotIdentity(assignedTo.newValue, account)
      : snapshot.assignedToBot,
    tags: tags ? splitAdoTags(tags.newValue) : snapshot.tags,
  };
}
