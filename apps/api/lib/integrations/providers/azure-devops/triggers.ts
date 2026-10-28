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
import { AdoEventAttribute, AzureDevOpsTriggerType } from "./constants";
import type { AdoConnectionConfig } from "./schemas";

/**
 * Trigger definitions. Filters compare case-insensitively; an empty filter
 * matches everything. Manual runs bypass `matches` (the engine applies no
 * filters when an admin picks the item explicitly).
 */

const filterListSchema = z
  .array(z.string().max(256))
  .max(50)
  .default([])
  .transform((values) => values.map((value) => value.trim()).filter(Boolean));

export const workItemAssignedConfigSchema = z.object({
  projects: filterListSchema,
  workItemTypes: filterListSchema,
  areaPathPrefix: z.string().trim().max(512).default(""),
  tags: filterListSchema,
});
export type WorkItemAssignedConfig = z.infer<
  typeof workItemAssignedConfigSchema
>;

export const workItemTaggedConfigSchema = z.object({
  tag: z.string().trim().min(1, "Enter the tag").max(256),
  projects: filterListSchema,
  workItemTypes: filterListSchema,
});
export type WorkItemTaggedConfig = z.infer<typeof workItemTaggedConfigSchema>;

const PROJECTS_FIELD: IntegrationFieldDescriptor = {
  key: "projects",
  label: "Projects",
  kind: IntegrationFieldKind.StringList,
  defaultValue: [],
  description: "Project names. Leave empty to match every project.",
};

const WORK_ITEM_TYPES_FIELD: IntegrationFieldDescriptor = {
  key: "workItemTypes",
  label: "Work item types",
  kind: IntegrationFieldKind.StringList,
  defaultValue: [],
  placeholder: "User Story",
  description:
    "For example User Story, Bug or Product Backlog Item. Leave empty to match every type.",
};

const MANUAL_RUN = { label: "Work item id", placeholder: "1234" };

export const workItemAssignedTrigger = defineTrigger<
  WorkItemAssignedConfig,
  AdoConnectionConfig
>({
  key: AzureDevOpsTriggerType.WorkItemAssigned,
  displayName: "Work item assigned to the bot",
  description:
    "Starts a run when a work item is created with, or changed to, the bot account as Assigned To.",
  configSchema: workItemAssignedConfigSchema,
  configFields: [
    PROJECTS_FIELD,
    WORK_ITEM_TYPES_FIELD,
    {
      key: "areaPathPrefix",
      label: "Area path",
      kind: IntegrationFieldKind.Text,
      placeholder: "Contoso\\Web",
      description:
        "Only work items in this area path or below it. Leave empty to match every area.",
    },
    {
      key: "tags",
      label: "Tags",
      kind: IntegrationFieldKind.StringList,
      defaultValue: [],
      description:
        "Only work items that have at least one of these tags. Leave empty to ignore tags.",
    },
  ],
  manualRun: MANUAL_RUN,
  matches: (event, config) =>
    matchesProjectAndType(event, config) &&
    isUnderAreaPath(
      readText(event, AdoEventAttribute.AreaPath),
      config.areaPathPrefix
    ) &&
    hasAnyTag(readList(event, AdoEventAttribute.Tags), config.tags),
});

export const workItemTaggedTrigger = defineTrigger<
  WorkItemTaggedConfig,
  AdoConnectionConfig
>({
  key: AzureDevOpsTriggerType.WorkItemTagged,
  displayName: "Tag added to a work item",
  description:
    "Starts a run when the tag is added to a work item (or a work item is created with it). In poll mode only work items assigned to the bot are seen.",
  configSchema: workItemTaggedConfigSchema,
  configFields: [
    {
      key: "tag",
      label: "Tag",
      kind: IntegrationFieldKind.Text,
      required: true,
      placeholder: "agentflow",
      description: "Tag that starts a run when it is added (case-insensitive).",
    },
    PROJECTS_FIELD,
    WORK_ITEM_TYPES_FIELD,
  ],
  manualRun: MANUAL_RUN,
  matches: (event, config) =>
    matchesProjectAndType(event, config) &&
    hasAnyTag(readList(event, AdoEventAttribute.AddedTags), [config.tag]),
});

export const workItemMentionedTrigger = defineTrigger<
  WorkItemAssignedConfig,
  AdoConnectionConfig
>({
  key: AzureDevOpsTriggerType.WorkItemMentioned,
  displayName: "Bot mentioned on a work item",
  description:
    'Starts a run when a comment (or the description of a new work item) mentions the bot account with @. Webhook mode needs the "Work item commented on" service hook; poll mode uses @RecentMentions.',
  configSchema: workItemAssignedConfigSchema,
  configFields: workItemAssignedTrigger.configFields,
  manualRun: MANUAL_RUN,
  matches: (event, config, connection) =>
    workItemAssignedTrigger.matches(event, config, connection),
});

const textAttributeSchema = z.string();
const listAttributeSchema = z.array(z.string());
const AREA_PATH_SEPARATOR = "\\";

function matchesProjectAndType(
  event: InboundEvent,
  config: { projects: string[]; workItemTypes: string[] }
): boolean {
  return (
    isOneOf(readText(event, AdoEventAttribute.Project), config.projects) &&
    isOneOf(
      readText(event, AdoEventAttribute.WorkItemType),
      config.workItemTypes
    )
  );
}

function isOneOf(value: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return true;
  }
  const actual = value?.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === actual);
}

function hasAnyTag(tags: string[], wanted: string[]): boolean {
  if (wanted.length === 0) {
    return true;
  }
  const present = new Set(tags.map((tag) => tag.toLowerCase()));
  return wanted.some((tag) => present.has(tag.toLowerCase()));
}

/** `Contoso\Web` matches `Contoso\Web` and `Contoso\Web\API`, not `Contoso\Website`. */
function isUnderAreaPath(areaPath: string | null, prefix: string): boolean {
  const wanted = normalizeAreaPath(prefix);
  if (!wanted) {
    return true;
  }
  const actual = normalizeAreaPath(areaPath ?? "");
  return (
    actual === wanted || actual.startsWith(`${wanted}${AREA_PATH_SEPARATOR}`)
  );
}

function normalizeAreaPath(value: string): string {
  const segments = value
    .replaceAll("/", AREA_PATH_SEPARATOR)
    .split(AREA_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.join(AREA_PATH_SEPARATOR).toLowerCase();
}

function readText(event: InboundEvent, key: AdoEventAttribute): string | null {
  const parsed = textAttributeSchema.safeParse(attribute(event, key));
  return parsed.success ? parsed.data : null;
}

function readList(event: InboundEvent, key: AdoEventAttribute): string[] {
  const parsed = listAttributeSchema.safeParse(attribute(event, key));
  return parsed.success ? parsed.data : [];
}

function attribute(
  event: InboundEvent,
  key: AdoEventAttribute
): InboundEventAttributeValue | undefined {
  return event.attributes[key];
}

export const workItemConditionsConfigSchema = z
  .object({
    match: z.enum(TriggerConditionMatch).default(TriggerConditionMatch.All),
    assigned: z.boolean().default(false),
    /** Any of these tags. */
    tags: filterListSchema,
    mentioned: z.boolean().default(false),
    projects: filterListSchema,
    workItemTypes: filterListSchema,
    areaPathPrefix: z.string().trim().max(512).default(""),
    states: filterListSchema,
  })
  .refine(
    (config) => config.assigned || config.tags.length > 0 || config.mentioned,
    {
      message: `${TRIGGER_CONDITIONS_REQUIRED_MESSAGE}: assigned, tags or mentioned`,
      path: ["assigned"],
    }
  );
export type WorkItemConditionsConfig = z.infer<
  typeof workItemConditionsConfigSchema
>;

/**
 * Combines "assigned to the bot", "has one of the tags" and "the bot is
 * mentioned" with AND (all) or OR (any), like Boards rules: e.g. assigned to
 * the bot AND tagged agentflow, in either order. See trigger-conditions.ts.
 */
export const workItemConditionsTrigger = defineTrigger<
  WorkItemConditionsConfig,
  AdoConnectionConfig
>({
  key: AzureDevOpsTriggerType.WorkItemConditions,
  displayName: "Work item matches conditions (assigned, tag, mention)",
  description:
    "Starts a run when a work item is assigned to the bot, gets one of the tags and/or mentions the bot, combined with AND (all) or OR (any): e.g. assigned to the bot AND tagged agentflow, in either order. In poll mode only work items assigned to the bot (and recent mentions) are seen.",
  configSchema: workItemConditionsConfigSchema,
  configFields: [
    TRIGGER_CONDITION_MATCH_FIELD,
    {
      key: "assigned",
      label: "Assigned to the bot",
      kind: IntegrationFieldKind.Boolean,
      defaultValue: false,
      description:
        "Assigned To is the connection's bot account. Assigning it is the moment this condition becomes true.",
    },
    {
      key: "tags",
      label: "Has a tag (any of)",
      kind: IntegrationFieldKind.StringList,
      defaultValue: [],
      placeholder: "agentflow",
      description:
        "The work item has at least one of these tags (case-insensitive). Adding one is the moment this condition becomes true. Leave empty to not use tags.",
    },
    {
      key: "mentioned",
      label: "Bot mentioned",
      kind: IntegrationFieldKind.Boolean,
      defaultValue: false,
      description:
        "A comment (or the description of a new work item) mentions the bot with @. A mention is a moment: with all, the run starts on the mention while the other conditions hold.",
    },
    PROJECTS_FIELD,
    WORK_ITEM_TYPES_FIELD,
    {
      key: "areaPathPrefix",
      label: "Area path",
      kind: IntegrationFieldKind.Text,
      placeholder: "Contoso\\Web",
      description:
        "Only work items in this area path or below it. Leave empty to match every area.",
    },
    {
      key: "states",
      label: "States",
      kind: IntegrationFieldKind.StringList,
      defaultValue: [],
      placeholder: "New",
      description:
        "e.g. New, Active. Leave empty to match every state (Boards column states are the work item's State).",
    },
  ],
  manualRun: MANUAL_RUN,
  matches: (event, config) =>
    matchesProjectAndType(event, config) &&
    isUnderAreaPath(
      readText(event, AdoEventAttribute.AreaPath),
      config.areaPathPrefix
    ) &&
    isOneOf(readText(event, AdoEventAttribute.State), config.states) &&
    triggerConditionsMatch(
      [
        {
          enabled: config.assigned,
          holds: readFlag(event, AdoEventAttribute.AssignedToBot),
          activated: readFlag(event, AdoEventAttribute.BecameAssigned),
        },
        {
          enabled: config.tags.length > 0,
          holds: hasAnyTag(
            readList(event, AdoEventAttribute.Tags),
            config.tags
          ),
          activated: hasAnyTag(
            readList(event, AdoEventAttribute.AddedTags),
            config.tags
          ),
        },
        {
          enabled: config.mentioned,
          holds: readFlag(event, AdoEventAttribute.Mentioned),
          activated: readFlag(event, AdoEventAttribute.Mentioned),
        },
      ],
      config.match
    ),
});

function readFlag(event: InboundEvent, key: AdoEventAttribute): boolean {
  return attribute(event, key) === true;
}
