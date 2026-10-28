import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import {
  TRIGGER_CONDITION_MATCH_FIELD,
  TRIGGER_CONDITIONS_REQUIRED_MESSAGE,
  TriggerConditionMatch,
  triggerConditionsMatch,
} from "../../trigger-conditions";
import {
  defineTrigger,
  type InboundEvent,
  type InboundEventAttributeValue,
} from "../../types";
import {
  JiraEventAttribute,
  JiraLabelChange,
  JiraTriggerType,
} from "./constants";
import type { JiraConnectionConfig } from "./schemas";

/**
 * Trigger types of the Jira provider. Filters are case-insensitive; an empty
 * filter list matches anything. Manual runs bypass `matches` (the engine
 * does not apply filters to an item the admin chose explicitly).
 */

const FILTER_VALUE_MAX_LENGTH = 255;
const FILTER_LIST_MAX_ITEMS = 50;
const LABEL_WHITESPACE_RE = /\s/;

const filterListSchema = z
  .array(z.string().max(FILTER_VALUE_MAX_LENGTH))
  .max(FILTER_LIST_MAX_ITEMS)
  .default([])
  .transform(cleanFilterList);

export const jiraIssueAssignedConfigSchema = z.object({
  projectKeys: filterListSchema,
  issueTypes: filterListSchema,
  /** Any of these labels. */
  labels: filterListSchema,
});
export type JiraIssueAssignedConfig = z.infer<
  typeof jiraIssueAssignedConfigSchema
>;

export const jiraIssueLabeledConfigSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Enter the label")
    .max(FILTER_VALUE_MAX_LENGTH)
    .refine((value) => !LABEL_WHITESPACE_RE.test(value), {
      message: "Jira labels cannot contain spaces",
    }),
  /** Which label changes start a run. */
  change: z.enum(JiraLabelChange).default(JiraLabelChange.Added),
  projectKeys: filterListSchema,
  issueTypes: filterListSchema,
});
export type JiraIssueLabeledConfig = z.infer<
  typeof jiraIssueLabeledConfigSchema
>;

const PROJECT_KEYS_FIELD: IntegrationFieldDescriptor = {
  key: "projectKeys",
  label: "Projects",
  kind: IntegrationFieldKind.StringList,
  description: "Project keys, e.g. PROJ. Leave empty for any project.",
  placeholder: "PROJ",
  defaultValue: [],
};

const ISSUE_TYPES_FIELD: IntegrationFieldDescriptor = {
  key: "issueTypes",
  label: "Issue types",
  kind: IntegrationFieldKind.StringList,
  description: "e.g. Story, Bug, Task. Leave empty for any issue type.",
  placeholder: "Story",
  defaultValue: [],
};

export const jiraIssueAssignedTrigger = defineTrigger<
  JiraIssueAssignedConfig,
  JiraConnectionConfig
>({
  key: JiraTriggerType.IssueAssigned,
  displayName: "Issue assigned to the bot",
  description:
    "Starts a run when a Jira issue is created with, or changed to, the connection's bot account as assignee.",
  configSchema: jiraIssueAssignedConfigSchema,
  configFields: [
    PROJECT_KEYS_FIELD,
    ISSUE_TYPES_FIELD,
    {
      key: "labels",
      label: "Labels (any of)",
      kind: IntegrationFieldKind.StringList,
      description:
        "Only issues that have at least one of these labels. Leave empty for no label filter.",
      placeholder: "ai-ready",
      defaultValue: [],
    },
  ],
  manualRun: { label: "Issue key", placeholder: "PROJ-123" },
  matches: (event, config) =>
    matchesIssueFilters(event, config) &&
    matchesAny(config.labels, readList(event, JiraEventAttribute.Labels)),
});

export const jiraIssueLabeledTrigger = defineTrigger<
  JiraIssueLabeledConfig,
  JiraConnectionConfig
>({
  key: JiraTriggerType.IssueLabeled,
  displayName: "Label added to or removed from an issue",
  description:
    "Starts a run when the label is added to a Jira issue (or an issue is created with it), removed from it, or either, per the change option. Needs webhook delivery (polling only detects assignments); a removal is only seen through webhooks.",
  configSchema: jiraIssueLabeledConfigSchema,
  configFields: [
    {
      key: "label",
      label: "Label",
      kind: IntegrationFieldKind.Text,
      required: true,
      description: "Jira label that starts a run, e.g. ai-ready.",
      placeholder: "ai-ready",
    },
    {
      key: "change",
      label: "Change",
      kind: IntegrationFieldKind.Select,
      description:
        "Start when the label is added (default), removed or either.",
      defaultValue: JiraLabelChange.Added,
      options: [
        { value: JiraLabelChange.Added, label: "Added" },
        { value: JiraLabelChange.Removed, label: "Removed" },
        { value: JiraLabelChange.Both, label: "Added or removed" },
      ],
    },
    PROJECT_KEYS_FIELD,
    ISSUE_TYPES_FIELD,
  ],
  manualRun: { label: "Issue key", placeholder: "PROJ-123" },
  matches: (event, config) =>
    matchesIssueFilters(event, config) && labelChangeMatches(event, config),
});

export const jiraIssueMentionedTrigger = defineTrigger<
  JiraIssueAssignedConfig,
  JiraConnectionConfig
>({
  key: JiraTriggerType.IssueMentioned,
  displayName: "Bot mentioned on an issue",
  description:
    "Starts a run when a comment, or the description of an issue, mentions the bot account with @. Needs webhook delivery with the Comment created / updated events.",
  configSchema: jiraIssueAssignedConfigSchema,
  configFields: jiraIssueAssignedTrigger.configFields,
  manualRun: { label: "Issue key", placeholder: "PROJ-123" },
  matches: (event, config, connection) =>
    jiraIssueAssignedTrigger.matches(event, config, connection),
});

function labelChangeMatches(
  event: InboundEvent,
  config: { label: string; change: JiraLabelChange }
): boolean {
  const added = matchesAny(
    [config.label],
    readList(event, JiraEventAttribute.AddedLabels)
  );
  const removed = matchesAny(
    [config.label],
    readList(event, JiraEventAttribute.RemovedLabels)
  );
  if (config.change === JiraLabelChange.Removed) {
    return removed;
  }
  if (config.change === JiraLabelChange.Both) {
    return added || removed;
  }
  return added;
}

function matchesIssueFilters(
  event: InboundEvent,
  config: { projectKeys: string[]; issueTypes: string[] }
): boolean {
  return (
    matchesAny(
      config.projectKeys,
      readList(event, JiraEventAttribute.ProjectKey)
    ) &&
    matchesAny(config.issueTypes, readList(event, JiraEventAttribute.IssueType))
  );
}

/** Empty filter = any value; otherwise at least one value must be in the filter (case-insensitive). */
function matchesAny(
  filter: readonly string[],
  values: readonly string[]
): boolean {
  if (filter.length === 0) {
    return true;
  }
  const wanted = new Set(filter.map(normalize));
  return values.some((value) => wanted.has(normalize(value)));
}

function readList(
  event: InboundEvent,
  attribute: JiraEventAttribute
): string[] {
  return toStringList(event.attributes[attribute]);
}

function toStringList(value: InboundEventAttributeValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" && value ? [value] : [];
}

function cleanFilterList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalize(trimmed);
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const STATUSES_FIELD: IntegrationFieldDescriptor = {
  key: "statuses",
  label: "Statuses",
  kind: IntegrationFieldKind.StringList,
  description: "e.g. To Do, Backlog. Leave empty for any status.",
  placeholder: "To Do",
  defaultValue: [],
};

const labelListSchema = z
  .array(
    z
      .string()
      .max(FILTER_VALUE_MAX_LENGTH)
      .refine((value) => !LABEL_WHITESPACE_RE.test(value.trim()), {
        message: "Jira labels cannot contain spaces",
      })
  )
  .max(FILTER_LIST_MAX_ITEMS)
  .default([])
  .transform(cleanFilterList);

export const jiraIssueConditionsConfigSchema = z
  .object({
    match: z.enum(TriggerConditionMatch).default(TriggerConditionMatch.All),
    assigned: z.boolean().default(false),
    /** Any of these labels. */
    labels: labelListSchema,
    mentioned: z.boolean().default(false),
    projectKeys: filterListSchema,
    issueTypes: filterListSchema,
    statuses: filterListSchema,
  })
  .refine(
    (config) => config.assigned || config.labels.length > 0 || config.mentioned,
    {
      message: `${TRIGGER_CONDITIONS_REQUIRED_MESSAGE}: assigned, labels or mentioned`,
      path: ["assigned"],
    }
  );
export type JiraIssueConditionsConfig = z.infer<
  typeof jiraIssueConditionsConfigSchema
>;

/**
 * Combines "assigned to the bot", "has one of the labels" and "the bot is
 * mentioned" with AND (all) or OR (any). See trigger-conditions.ts for when
 * an occurrence counts.
 */
export const jiraIssueConditionsTrigger = defineTrigger<
  JiraIssueConditionsConfig,
  JiraConnectionConfig
>({
  key: JiraTriggerType.IssueConditions,
  displayName: "Issue matches conditions (assigned, label, mention)",
  description:
    "Starts a run when an issue is assigned to the bot, gets one of the labels and/or mentions the bot, combined with AND (all) or OR (any): e.g. assigned to the bot AND labeled ai-ready, in either order. Labels and mentions need webhook delivery; polling only sees issues assigned to the bot.",
  configSchema: jiraIssueConditionsConfigSchema,
  configFields: [
    TRIGGER_CONDITION_MATCH_FIELD,
    {
      key: "assigned",
      label: "Assigned to the bot",
      kind: IntegrationFieldKind.Boolean,
      defaultValue: false,
      description:
        "The issue is assigned to the connection's bot account. Assigning it is the moment this condition becomes true.",
    },
    {
      key: "labels",
      label: "Has a label (any of)",
      kind: IntegrationFieldKind.StringList,
      defaultValue: [],
      placeholder: "ai-ready",
      description:
        "The issue has at least one of these labels. Adding one is the moment this condition becomes true. Leave empty to not use labels.",
    },
    {
      key: "mentioned",
      label: "Bot mentioned",
      kind: IntegrationFieldKind.Boolean,
      defaultValue: false,
      description:
        "A comment, or the description, mentions the bot with @. A mention is a moment: with all, the run starts on the mention while the other conditions hold.",
    },
    PROJECT_KEYS_FIELD,
    ISSUE_TYPES_FIELD,
    STATUSES_FIELD,
  ],
  manualRun: { label: "Issue key", placeholder: "PROJ-123" },
  matches: (event, config) =>
    matchesIssueFilters(event, config) &&
    matchesAny(config.statuses, readList(event, JiraEventAttribute.Status)) &&
    triggerConditionsMatch(
      [
        {
          enabled: config.assigned,
          holds: readFlag(event, JiraEventAttribute.AssignedToBot),
          activated: readFlag(event, JiraEventAttribute.BecameAssigned),
        },
        {
          enabled: config.labels.length > 0,
          holds: matchesAny(
            config.labels,
            readList(event, JiraEventAttribute.Labels)
          ),
          activated: matchesAny(
            config.labels,
            readList(event, JiraEventAttribute.AddedLabels)
          ),
        },
        {
          enabled: config.mentioned,
          holds: readFlag(event, JiraEventAttribute.Mentioned),
          activated: readFlag(event, JiraEventAttribute.Mentioned),
        },
      ],
      config.match
    ),
});

function readFlag(event: InboundEvent, attribute: JiraEventAttribute): boolean {
  return event.attributes[attribute] === true;
}

export const jiraIssueStatusChangedConfigSchema = z.object({
  /** Any of these statuses before the change. */
  from: filterListSchema,
  /** Any of these statuses after the change. */
  to: filterListSchema,
  projectKeys: filterListSchema,
  issueTypes: filterListSchema,
});
export type JiraIssueStatusChangedConfig = z.infer<
  typeof jiraIssueStatusChangedConfigSchema
>;

export const jiraIssueStatusChangedTrigger = defineTrigger<
  JiraIssueStatusChangedConfig,
  JiraConnectionConfig
>({
  key: JiraTriggerType.IssueStatusChanged,
  displayName: "Issue status changed",
  description:
    "Starts when a person moves a Jira issue to another status (from / to filters, case-insensitive names). Needs webhook delivery with the Issue updated event; the bot's own transitions are ignored.",
  configSchema: jiraIssueStatusChangedConfigSchema,
  configFields: [
    {
      key: "from",
      label: "From statuses (any of)",
      kind: IntegrationFieldKind.StringList,
      description: "Status names. Leave empty for any.",
      placeholder: "PRD Review",
      defaultValue: [],
    },
    {
      key: "to",
      label: "To statuses (any of)",
      kind: IntegrationFieldKind.StringList,
      description: "Status names. Leave empty for any.",
      placeholder: "Ready for Dev",
      defaultValue: [],
    },
    PROJECT_KEYS_FIELD,
    ISSUE_TYPES_FIELD,
  ],
  matches: (event, config) =>
    matchesIssueFilters(event, config) &&
    matchesAny(config.from, readList(event, JiraEventAttribute.FromStatus)) &&
    matchesAny(config.to, readList(event, JiraEventAttribute.ToStatus)),
});
