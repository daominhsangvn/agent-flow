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
  type AdoActionContext,
  failed,
  resolveTarget,
  workItemRevisionRef,
} from "./actions";
import { ADO_API_VERSION, adoRequest, JSON_PATCH_CONTENT_TYPE } from "./client";
import {
  ADO_HYPERLINK_RELATION,
  AdoField,
  AzureDevOpsActionType,
  JsonPatchOperation,
} from "./constants";
import { splitAdoTags } from "./events";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoWorkItemSchema,
  readWorkItemFields,
} from "./schemas";

/**
 * Azure DevOps actions on the run's work item besides comments and states:
 * its tags (the labels of `source: [label]`) and its web links (`source:
 * [link]`, e.g. the page its plan is reviewed on). Both read the work item
 * first: tags are one field, rewritten under a test of the revision read, and
 * a link the work item already has is not added twice.
 */

const TAGS_MAX = 20;
const TAG_MAX_LENGTH = 400;
const LINK_TITLE_MAX_LENGTH = 255;
const TAG_SEPARATOR = "; ";

const tagListSchema = z
  .array(z.string().trim().min(1).max(TAG_MAX_LENGTH))
  .max(TAGS_MAX)
  .default([]);

export const updateTagsConfigSchema = z
  .object({ add: tagListSchema, remove: tagListSchema })
  .refine((config) => config.add.length + config.remove.length > 0, {
    message: "Add or remove at least one tag",
  });
export type UpdateTagsConfig = z.infer<typeof updateTagsConfigSchema>;

export const addLinkConfigSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().trim().min(1).max(LINK_TITLE_MAX_LENGTH),
});
export type AddLinkConfig = z.infer<typeof addLinkConfigSchema>;

const UPDATE_TAGS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "add",
    label: "Add tags",
    kind: IntegrationFieldKind.StringList,
    description: "Tags to add to the work item.",
  },
  {
    key: "remove",
    label: "Remove tags",
    kind: IntegrationFieldKind.StringList,
    description:
      "Tags to remove from the work item (case-insensitive); a tag it does not have is ignored.",
  },
];

const ADD_LINK_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "url",
    label: "Link",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
    description: "Address of the web link; a link the work item has is kept.",
  },
  {
    key: "title",
    label: "Title",
    kind: IntegrationFieldKind.Text,
    required: true,
    placeholder: "Implementation plan",
  },
];

export const updateTagsAction = defineAction<
  UpdateTagsConfig,
  AdoConnectionConfig,
  AdoSecrets
>({
  key: AzureDevOpsActionType.UpdateTags,
  displayName: "Change the work item tags",
  description:
    "Adds and removes tags on the Azure DevOps work item that started the run, e.g. removes the tag that started it.",
  configSchema: updateTagsConfigSchema,
  configFields: UPDATE_TAGS_FIELDS,
  sourceOperation: SourceOperation.Label,
  defaultEvents: [WorkflowRunEvent.Triggered],
  execute: executeUpdateTags,
});

export const addLinkAction = defineAction<
  AddLinkConfig,
  AdoConnectionConfig,
  AdoSecrets
>({
  key: AzureDevOpsActionType.AddLink,
  displayName: "Add a web link to the work item",
  description:
    "Adds a web link to the Azure DevOps work item that started the run, e.g. the page its plan is reviewed on.",
  configSchema: addLinkConfigSchema,
  configFields: ADD_LINK_FIELDS,
  sourceOperation: SourceOperation.Link,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: executeAddLink,
});

async function executeUpdateTags(
  ctx: AdoActionContext<UpdateTagsConfig>
): Promise<ActionResult> {
  const target = resolveTarget(ctx.run, ctx.connection.config.organizationUrl);
  if (!target.ok) {
    return target.error;
  }
  const { workItemId } = target.value;
  const current = await readWorkItem(ctx, workItemId, false);
  if (!current.ok) {
    return failed(current.error, "Could not read the work item's tags");
  }
  const tags = changedTags(
    splitAdoTags(readWorkItemFields(current.value.fields)[AdoField.Tags]),
    ctx.config
  );
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Patch,
      path: `_apis/wit/workitems/${workItemId}`,
      query: { "api-version": ADO_API_VERSION },
      body: [
        ...revisionTest(current.value.rev),
        {
          op: JsonPatchOperation.Add,
          path: `/fields/${AdoField.Tags}`,
          value: tags.join(TAG_SEPARATOR),
        },
      ],
      contentType: JSON_PATCH_CONTENT_TYPE,
    },
    adoWorkItemSchema
  );
  if (!result.ok) {
    return failed(result.error, "Could not change the tags");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: workItemRevisionRef(workItemId, result.value.rev),
    detail: `Tags of #${workItemId}: ${tags.join(", ") || "none"}`,
  };
}

async function executeAddLink(
  ctx: AdoActionContext<AddLinkConfig>
): Promise<ActionResult> {
  const target = resolveTarget(ctx.run, ctx.connection.config.organizationUrl);
  if (!target.ok) {
    return target.error;
  }
  const { workItemId } = target.value;
  const { url, title } = ctx.config;
  const current = await readWorkItem(ctx, workItemId, true);
  if (!current.ok) {
    return failed(current.error, "Could not read the work item's links");
  }
  const linked = (current.value.relations ?? []).some(
    (relation) =>
      relation.rel === ADO_HYPERLINK_RELATION && relation.url === url
  );
  if (linked) {
    return {
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: url,
      detail: `#${workItemId} already links ${url}`,
    };
  }
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Patch,
      path: `_apis/wit/workitems/${workItemId}`,
      query: { "api-version": ADO_API_VERSION },
      body: [
        {
          op: JsonPatchOperation.Add,
          path: "/relations/-",
          value: {
            rel: ADO_HYPERLINK_RELATION,
            url,
            attributes: { comment: title },
          },
        },
      ],
      contentType: JSON_PATCH_CONTENT_TYPE,
    },
    adoWorkItemSchema
  );
  if (!result.ok) {
    return failed(result.error, "Could not add the link");
  }
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: url,
    detail: `Linked "${title}" (${url}) on #${workItemId}`,
  };
}

function readWorkItem(
  ctx: AdoActionContext<unknown>,
  workItemId: number,
  withRelations: boolean
) {
  return adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `_apis/wit/workitems/${workItemId}`,
      query: {
        "api-version": ADO_API_VERSION,
        ...(withRelations ? { $expand: "relations" } : {}),
      },
    },
    adoWorkItemSchema
  );
}

/** The tags after the change: removals case-insensitive, no duplicates. */
function changedTags(
  current: readonly string[],
  change: { add: readonly string[]; remove: readonly string[] }
): string[] {
  const removed = new Set(change.remove.map((tag) => tag.toLowerCase()));
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...current, ...change.add]) {
    const key = tag.toLowerCase();
    if (removed.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** A patch that fails when the work item changed since `rev` was read. */
function revisionTest(rev: number | null | undefined) {
  return rev ? [{ op: JsonPatchOperation.Test, path: "/rev", value: rev }] : [];
}
