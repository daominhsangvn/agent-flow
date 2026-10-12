import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import {
  defineTrigger,
  type InboundEvent,
  type InboundEventAttributeValue,
} from "../../types";
import { JiraEventAttribute, JiraTriggerType } from "./constants";
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
  displayName: "Label added to an issue",
  description:
    "Starts a run when the label is added to a Jira issue, or an issue is created with it. Needs webhook delivery (polling only detects assignments).",
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
    PROJECT_KEYS_FIELD,
    ISSUE_TYPES_FIELD,
  ],
  manualRun: { label: "Issue key", placeholder: "PROJ-123" },
  matches: (event, config) =>
    matchesIssueFilters(event, config) &&
    matchesAny([config.label], readList(event, JiraEventAttribute.AddedLabels)),
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
