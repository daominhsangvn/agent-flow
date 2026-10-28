import { Result } from "@repo/api/src/types/result";
import { htmlToMarkdown } from "../../markdown";
import {
  HttpMethod,
  type InboundEvent,
  RetryableSourceError,
  type SourceItem,
  type SourceItemAttachment,
  type SourceItemComment,
  type SourceItemLink,
  type SourceItemRef,
} from "../../types";
import {
  ADO_API_VERSION,
  ADO_COMMENTS_API_VERSION,
  type AdoContext,
  type AdoError,
  AdoErrorKind,
  adoRequest,
  projectSegment,
} from "./client";
import {
  ADO_ATTACHMENT_RELATION,
  ADO_HYPERLINK_RELATION,
  AdoField,
  AdoTextFormat,
} from "./constants";
import { splitAdoTags, workItemAttributes, workItemRef } from "./events";
import { adoIdentityEmail, adoIdentityLabel } from "./identity";
import {
  type AdoComment,
  type AdoRelation,
  type AdoWorkItem,
  type AdoWorkItemFields,
  adoCommentListSchema,
  adoWorkItemSchema,
  parseUrl,
  parseWorkItemId,
  readWorkItemFields,
  urlBelongsToOrganization,
} from "./schemas";

/**
 * Loads the canonical work item (webhook payloads are only hints) and
 * normalizes it to markdown: description, extra sections (acceptance
 * criteria, repro steps, system info), the latest comments and attachment
 * links. Multi-line fields are HTML unless the work item stores them as
 * Markdown. Temporary failures (rate limit, 5xx, timeout, network) throw
 * RetryableSourceError so the engine retries the import; every other
 * failure throws a plain Error.
 */

export const ADO_SOURCE_COMMENT_LIMIT = 20;

export async function fetchAdoSourceItem(
  ctx: AdoContext,
  ref: SourceItemRef
): Promise<SourceItem> {
  const workItemId = parseWorkItemId(ref.externalId);
  if (workItemId === null) {
    throw new Error(`Invalid Azure DevOps work item id "${ref.externalId}"`);
  }
  const result = await getWorkItem(ctx, workItemId, WorkItemExpand.All);
  if (!result.ok) {
    throw fetchFailure(workItemId, result.error);
  }
  const workItem = result.value;
  const fields = readWorkItemFields(workItem.fields);
  const project = fields[AdoField.TeamProject] ?? ref.container;
  const comments = project ? await fetchComments(ctx, project, workItemId) : [];
  const itemRef = workItemRef(
    ctx.connection.config.organizationUrl,
    workItemId,
    fields,
    ref.container
  );
  return {
    ...itemRef,
    title: fields[AdoField.Title] ?? ref.title ?? `Work item #${workItemId}`,
    bodyMarkdown: fieldMarkdown(workItem, fields, AdoField.Description),
    itemType: fields[AdoField.WorkItemType],
    status: fields[AdoField.State],
    priority: fields[AdoField.Priority],
    labels: splitAdoTags(fields[AdoField.Tags]),
    reporter: adoIdentityLabel(fields[AdoField.CreatedBy]),
    assignee: adoIdentityLabel(fields[AdoField.AssignedTo]),
    reporterEmail: adoIdentityEmail(fields[AdoField.CreatedBy]),
    assigneeEmail: adoIdentityEmail(fields[AdoField.AssignedTo]),
    sections: buildSections(workItem, fields),
    comments,
    attachments: buildAttachments(workItem.relations),
    links: buildLinks(workItem.relations),
  };
}

/**
 * Manual run input: `1234`, `#1234` or a work item URL of this organization.
 * Trigger filters are not applied to manual runs, so any readable item works.
 */
export async function resolveAdoManualEvent(
  ctx: AdoContext,
  input: string,
  triggerType: string
): Promise<InboundEvent> {
  const workItemId = parseManualInput(
    input,
    ctx.connection.config.organizationUrl
  );
  const result = await getWorkItem(ctx, workItemId, WorkItemExpand.None);
  if (!result.ok) {
    throw fetchFailure(workItemId, result.error);
  }
  const fields = readWorkItemFields(result.value.fields);
  return {
    triggerType,
    dedupKey: `${workItemId}:manual`,
    occurredAt: ctx.now(),
    actor: null,
    item: workItemRef(
      ctx.connection.config.organizationUrl,
      workItemId,
      fields,
      null
    ),
    attributes: workItemAttributes(fields, null),
  };
}

/** Markdown for a multi-line field: kept as-is when stored as Markdown, converted when HTML. */
export function richTextToMarkdown(
  value: string | null,
  format: string | null | undefined
): string {
  if (!value) {
    return "";
  }
  const normalizedFormat = format?.toLowerCase();
  if (normalizedFormat === AdoTextFormat.Markdown) {
    return value.trim();
  }
  if (normalizedFormat === AdoTextFormat.Html || HTML_TAG_RE.test(value)) {
    return htmlToMarkdown(value);
  }
  return value.trim();
}

const WorkItemExpand = {
  None: "none",
  All: "all",
} as const;
type WorkItemExpand = (typeof WorkItemExpand)[keyof typeof WorkItemExpand];

const MANUAL_INPUT_HINT =
  "Enter an Azure DevOps work item id (1234), #1234 or a work item URL";
const WORK_ITEM_ID_RE = /^#?(\d+)$/;
const WORK_ITEM_URL_PATH_RE =
  /\/(?:_workitems\/edit|_apis\/wit\/workitems)\/(\d+)(?:\/|$)/i;
/** Tags the ADO rich text editor emits; plain text and markdown contain none of them. */
const HTML_TAG_RE =
  /<\/?(?:a|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|span|strong|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/i;
/** CommentFormat enum value of Markdown when serialized as a number. */
const COMMENT_FORMAT_MARKDOWN_ORDINAL = 0;

const SECTION_FIELDS = [
  { field: AdoField.AcceptanceCriteria, title: "Acceptance Criteria" },
  { field: AdoField.ReproSteps, title: "Repro Steps" },
  { field: AdoField.SystemInfo, title: "System Info" },
] as const;

/** `$expand` and `fields` cannot be combined, so fields are picked client-side. */
function getWorkItem(
  ctx: AdoContext,
  workItemId: number,
  expand: WorkItemExpand
) {
  return adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `_apis/wit/workitems/${workItemId}`,
      query: { $expand: expand, "api-version": ADO_API_VERSION },
    },
    adoWorkItemSchema
  );
}

/** Latest comments, oldest first. Failures are logged and yield no comments. */
async function fetchComments(
  ctx: AdoContext,
  project: string,
  workItemId: number
): Promise<SourceItemComment[]> {
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `${projectSegment(project)}/_apis/wit/workItems/${workItemId}/comments`,
      query: {
        $top: ADO_SOURCE_COMMENT_LIMIT,
        order: "desc",
        $expand: "renderedText",
        "api-version": ADO_COMMENTS_API_VERSION,
      },
    },
    adoCommentListSchema
  );
  if (!result.ok) {
    ctx.log.warn("Azure DevOps work item comments unavailable", {
      workItemId,
      error: result.error.message,
    });
    return [];
  }
  return (result.value.comments ?? [])
    .filter((comment) => !comment.isDeleted)
    .map(toSourceComment)
    .filter((comment) => comment.bodyMarkdown.length > 0)
    .reverse();
}

function toSourceComment(comment: AdoComment): SourceItemComment {
  return {
    author: adoIdentityLabel(comment.createdBy),
    createdAt: comment.createdDate ?? null,
    bodyMarkdown: commentMarkdown(comment),
  };
}

function commentMarkdown(comment: AdoComment): string {
  if (isMarkdownCommentFormat(comment.format)) {
    return comment.text?.trim() ?? "";
  }
  if (comment.format === null || comment.format === undefined) {
    return richTextToMarkdown(comment.text ?? null, null);
  }
  return htmlToMarkdown(comment.renderedText ?? comment.text);
}

function isMarkdownCommentFormat(format: AdoComment["format"]): boolean {
  if (format === COMMENT_FORMAT_MARKDOWN_ORDINAL) {
    return true;
  }
  return String(format ?? "").toLowerCase() === AdoTextFormat.Markdown;
}

function fieldMarkdown(
  workItem: AdoWorkItem,
  fields: AdoWorkItemFields,
  field: (typeof SECTION_FIELDS)[number]["field"] | typeof AdoField.Description
): string {
  return richTextToMarkdown(
    fields[field],
    workItem.multilineFieldsFormat?.[field]
  );
}

function buildSections(
  workItem: AdoWorkItem,
  fields: AdoWorkItemFields
): SourceItem["sections"] {
  return SECTION_FIELDS.map(({ field, title }) => ({
    title,
    markdown: fieldMarkdown(workItem, fields, field),
  })).filter((section) => section.markdown.length > 0);
}

function buildAttachments(
  relations: AdoRelation[] | null | undefined
): SourceItemAttachment[] {
  return (relations ?? [])
    .filter((relation) => relation.rel === ADO_ATTACHMENT_RELATION)
    .map((relation) => ({
      name: relation.attributes?.name?.trim() || "attachment",
      url: relation.url ?? null,
      mimeType: null,
      size: relation.attributes?.resourceSize ?? null,
    }));
}

function describeFetchError(workItemId: number, error: AdoError): string {
  if (error.kind === AdoErrorKind.NotFound) {
    return `Azure DevOps work item #${workItemId} was not found, or the token cannot read it`;
  }
  return `Could not load Azure DevOps work item #${workItemId}: ${error.message}`;
}

/** A work item from its id (`123`, `#123`) or link (an agent's connection_get_item). */
export function parseAdoItemReference(
  config: { organizationUrl: string },
  input: string
): Result<{ externalId: string; key: string }, string> {
  try {
    const workItemId = parseManualInput(input, config.organizationUrl);
    return Result.ok({ externalId: String(workItemId), key: `#${workItemId}` });
  } catch (error) {
    return Result.err(
      error instanceof Error ? error.message : MANUAL_INPUT_HINT
    );
  }
}

function parseManualInput(input: string, organizationUrl: string): number {
  const value = input.trim();
  const direct = WORK_ITEM_ID_RE.exec(value);
  if (direct) {
    return requireWorkItemId(direct[1]);
  }
  const url = parseUrl(value);
  if (!url) {
    throw new Error(MANUAL_INPUT_HINT);
  }
  if (!urlBelongsToOrganization(url, organizationUrl)) {
    throw new Error(
      `The work item URL does not belong to the connection's organization (${organizationUrl})`
    );
  }
  const fromPath = WORK_ITEM_URL_PATH_RE.exec(url.pathname);
  return requireWorkItemId(fromPath?.[1] ?? url.searchParams.get("id"));
}

function requireWorkItemId(value: string | null | undefined): number {
  const workItemId = value ? parseWorkItemId(value) : null;
  if (workItemId === null) {
    throw new Error(MANUAL_INPUT_HINT);
  }
  return workItemId;
}

/** RetryableSourceError for temporary failures, a plain Error otherwise (same message). */
function fetchFailure(workItemId: number, error: AdoError): Error {
  const message = describeFetchError(workItemId, error);
  return error.retryable
    ? new RetryableSourceError(message)
    : new Error(message);
}

function buildLinks(
  relations: AdoRelation[] | null | undefined
): SourceItemLink[] {
  return (relations ?? []).flatMap((relation) =>
    relation.rel === ADO_HYPERLINK_RELATION && relation.url
      ? [{ url: relation.url, title: relation.attributes?.comment ?? null }]
      : []
  );
}
