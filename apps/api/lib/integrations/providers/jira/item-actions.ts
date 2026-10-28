import { SourceOperation } from "@repo/api/src/types/connection-grants";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import { type ActionResult, defineAction, HttpMethod } from "../../types";
import {
  failed,
  type JiraActionContext,
  resolveSourceIssue,
  skipped,
} from "./actions";
import { jiraIssuePath, jiraRequestWithoutBody } from "./client";
import { JiraActionType } from "./constants";
import type { JiraConnectionConfig, JiraSecrets } from "./schemas";

/**
 * Jira actions on the run's source issue besides comments and transitions:
 * its labels (e.g. remove the label that started the run, or a review label
 * once it was acted on) and its web links (e.g. the Confluence page of the
 * plan, so a later run finds it). Both act only on the run's own issue
 * (`source: [label]`, `source: [link]` for agents).
 */

const LABELS_MAX = 20;
const LABEL_MAX_LENGTH = 255;
const LINK_TITLE_MAX_LENGTH = 255;
/** Jira labels are single words. */
const LABEL_RE = /^\S+$/;

const labelListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(LABEL_MAX_LENGTH)
      .regex(LABEL_RE, "A Jira label has no spaces")
  )
  .max(LABELS_MAX)
  .default([]);

export const jiraUpdateLabelsConfigSchema = z
  .object({ add: labelListSchema, remove: labelListSchema })
  .refine((config) => config.add.length + config.remove.length > 0, {
    message: "Add or remove at least one label",
  });
export type JiraUpdateLabelsConfig = z.infer<
  typeof jiraUpdateLabelsConfigSchema
>;

export const jiraAddLinkConfigSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().trim().min(1).max(LINK_TITLE_MAX_LENGTH),
});
export type JiraAddLinkConfig = z.infer<typeof jiraAddLinkConfigSchema>;

const UPDATE_LABELS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "add",
    label: "Add labels",
    kind: IntegrationFieldKind.StringList,
    description: "Labels to add to the issue (single words).",
  },
  {
    key: "remove",
    label: "Remove labels",
    kind: IntegrationFieldKind.StringList,
    description:
      "Labels to remove from the issue; a label it does not have is ignored.",
  },
];

const ADD_LINK_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "url",
    label: "Link",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
    description:
      "Address of the web link; adding a link the issue already has updates its title.",
  },
  {
    key: "title",
    label: "Title",
    kind: IntegrationFieldKind.Text,
    required: true,
    placeholder: "Implementation plan",
  },
];

export const jiraUpdateLabelsAction = defineAction<
  JiraUpdateLabelsConfig,
  JiraConnectionConfig,
  JiraSecrets
>({
  key: JiraActionType.UpdateLabels,
  displayName: "Change the labels of the Jira issue",
  description:
    "Adds and removes labels on the Jira issue the run was started from, e.g. removes the label that started the run.",
  configSchema: jiraUpdateLabelsConfigSchema,
  configFields: UPDATE_LABELS_FIELDS,
  sourceOperation: SourceOperation.Label,
  defaultEvents: [WorkflowRunEvent.Triggered],
  execute: executeUpdateLabels,
});

export const jiraAddLinkAction = defineAction<
  JiraAddLinkConfig,
  JiraConnectionConfig,
  JiraSecrets
>({
  key: JiraActionType.AddLink,
  displayName: "Add a web link to the Jira issue",
  description:
    "Adds a web link to the Jira issue the run was started from, e.g. the page its plan is reviewed on.",
  configSchema: jiraAddLinkConfigSchema,
  configFields: ADD_LINK_FIELDS,
  sourceOperation: SourceOperation.Link,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: executeAddLink,
});

async function executeUpdateLabels(
  ctx: JiraActionContext<JiraUpdateLabelsConfig>
): Promise<ActionResult> {
  const issue = resolveSourceIssue(ctx);
  if (!issue.ok) {
    return skipped(issue.error);
  }
  const { add, remove } = ctx.config;
  const updated = await jiraRequestWithoutBody(ctx, {
    method: HttpMethod.Put,
    path: jiraIssuePath(issue.value),
    body: {
      update: {
        labels: [
          ...add.map((label) => ({ add: label })),
          ...remove.map((label) => ({ remove: label })),
        ],
      },
    },
  });
  if (!updated.ok) {
    return failed(ctx, updated.error, "change the labels");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    detail: `Labels of ${ctx.run.source.key}: ${describeLabelChange(add, remove)}.`,
  };
}

async function executeAddLink(
  ctx: JiraActionContext<JiraAddLinkConfig>
): Promise<ActionResult> {
  const issue = resolveSourceIssue(ctx);
  if (!issue.ok) {
    return skipped(issue.error);
  }
  const { url, title } = ctx.config;
  // The URL as global id: adding the same link again updates it in place.
  const linked = await jiraRequestWithoutBody(ctx, {
    method: HttpMethod.Post,
    path: jiraIssuePath(issue.value, "remotelink"),
    body: { globalId: url, object: { url, title } },
  });
  if (!linked.ok) {
    return failed(ctx, linked.error, "add the link");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: url,
    detail: `Linked "${title}" (${url}) on ${ctx.run.source.key}.`,
  };
}

function describeLabelChange(
  add: readonly string[],
  remove: readonly string[]
): string {
  return [
    ...add.map((label) => `+${label}`),
    ...remove.map((label) => `-${label}`),
  ].join(", ");
}
