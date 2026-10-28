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
import { adfToPlainText } from "../atlassian/adf";
import {
  type JiraContext,
  type JiraError,
  JiraErrorKind,
  jiraIssuePath,
  jiraRequest,
} from "./client";
import { JiraTriggerType } from "./constants";
import { toIsoDate } from "./dates";
import { jiraItemRef, jiraManualEvent } from "./issue-events";
import {
  type JiraAttachment,
  type JiraComment,
  type JiraIssue,
  jiraCommentPageSchema,
  jiraIssueSchema,
  jiraRemoteLinksSchema,
} from "./schemas";

/**
 * Source side of the Jira provider: loads the canonical issue (webhook
 * payloads are hints only) and resolves manual-run input. Temporary failures
 * (rate limit, 5xx, timeout, network) throw RetryableSourceError so the
 * engine retries the import; every other failure throws a plain Error.
 *
 * Rich text comes from `renderedFields` / `renderedBody` (HTML on both Cloud
 * and Data Center) converted to markdown; raw values (wiki markup strings on
 * v2, ADF on v3) are the fallback. Custom fields whose name contains
 * "Acceptance Criteria" become their own section.
 */

export const JIRA_COMMENT_LIMIT = 20;

export const JIRA_INVALID_ISSUE_REFERENCE =
  "Enter a Jira issue key such as PROJ-123 or a link to the issue.";

export async function fetchJiraIssue(
  ctx: JiraContext,
  ref: SourceItemRef
): Promise<SourceItem> {
  const issue = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(ref.externalId || ref.key),
      query: { fields: "*all,-comment", expand: "renderedFields,names" },
    },
    jiraIssueSchema
  );
  if (!issue.ok) {
    throw sourceFailure(
      `Could not load Jira issue ${ref.key}: ${issue.error.message}`,
      issue.error
    );
  }
  const comments = await fetchLatestComments(ctx, issue.value);
  const links = await fetchRemoteLinks(ctx, issue.value);
  return {
    ...toSourceItem(ctx.connection.config.siteUrl, issue.value, comments),
    links,
  };
}

/**
 * Manual run: `input` is an issue key or a link to the issue on this site.
 * Throws an Error with a user-facing message when the input is invalid or
 * the issue cannot be read.
 */
export async function resolveJiraManual(
  ctx: JiraContext,
  input: string,
  triggerType: string
): Promise<InboundEvent> {
  if (!isJiraTriggerType(triggerType)) {
    throw new Error(
      `Jira cannot start a run for the trigger type "${triggerType}".`
    );
  }
  const siteUrl = ctx.connection.config.siteUrl;
  const key = parseJiraIssueReference(input, siteUrl);
  if (!key.ok) {
    throw new Error(key.error);
  }
  const issue = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(key.value),
      query: { fields: MANUAL_FIELDS },
    },
    jiraIssueSchema
  );
  if (!issue.ok) {
    throw sourceFailure(
      describeManualFailure(key.value, issue.error),
      issue.error
    );
  }
  return jiraManualEvent(
    { siteUrl, issue: issue.value, occurredAt: ctx.now(), actor: null },
    triggerType
  );
}

/** An issue of the site from a key or a link (an agent's connection_get_item). */
export function parseJiraItemReference(
  config: { siteUrl: string },
  input: string
): Result<{ externalId: string; key: string }, string> {
  const key = parseJiraIssueReference(input, config.siteUrl);
  return key.ok
    ? Result.ok({ externalId: key.value, key: key.value })
    : Result.err(key.error);
}

/** An issue key (any case) or a browse/board link on the connection's site. */
export function parseJiraIssueReference(
  input: string,
  siteUrl: string
): Result<string, string> {
  const trimmed = input.trim();
  if (ISSUE_KEY_RE.test(trimmed)) {
    return Result.ok(trimmed.toUpperCase());
  }
  if (!URL.canParse(trimmed)) {
    return Result.err(JIRA_INVALID_ISSUE_REFERENCE);
  }
  const url = new URL(trimmed);
  const site = new URL(siteUrl);
  if (url.host.toLowerCase() !== site.host.toLowerCase()) {
    return Result.err(
      `The link is not on this connection's Jira site (${site.host}).`
    );
  }
  const key = issueKeyFromUrl(url);
  return key ? Result.ok(key) : Result.err(JIRA_INVALID_ISSUE_REFERENCE);
}

export function toSourceItem(
  siteUrl: string,
  issue: JiraIssue,
  comments: JiraComment[]
): SourceItem {
  const fields = issue.fields;
  return {
    ...jiraItemRef(siteUrl, issue),
    title: fields.summary?.trim() || issue.key,
    bodyMarkdown: fieldMarkdown(issue, DESCRIPTION_FIELD),
    itemType: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
    priority: fields.priority?.name ?? null,
    labels: fields.labels ?? [],
    reporter: fields.reporter?.displayName ?? null,
    assignee: fields.assignee?.displayName ?? null,
    reporterEmail: fields.reporter?.emailAddress ?? null,
    assigneeEmail: fields.assignee?.emailAddress ?? null,
    sections: acceptanceCriteriaSections(issue),
    comments: comments
      .map(toSourceComment)
      .filter((comment) => comment.bodyMarkdown.length > 0),
    attachments: (fields.attachment ?? []).map(toSourceAttachment),
  };
}

const DESCRIPTION_FIELD = "description";
const MANUAL_FIELDS = "summary,issuetype,labels,status,project,assignee";
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;
const ACCEPTANCE_CRITERIA_RE = /acceptance criteria/i;
const SELECTED_ISSUE_PARAM = "selectedIssue";
const SUPPORTED_TRIGGER_TYPES = new Set<string>(Object.values(JiraTriggerType));

/** Latest comments, oldest first. A failure here does not fail the import. */
async function fetchLatestComments(
  ctx: JiraContext,
  issue: JiraIssue
): Promise<JiraComment[]> {
  const page = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(issue.id, "comment"),
      query: {
        orderBy: "-created",
        maxResults: JIRA_COMMENT_LIMIT,
        expand: "renderedBody",
      },
    },
    jiraCommentPageSchema
  );
  if (!page.ok) {
    ctx.log.warn("Could not load Jira comments; importing without them", {
      connectionId: ctx.connection.id,
      issueKey: issue.key,
      status: page.error.status,
      kind: page.error.kind,
    });
    return [];
  }
  return (page.value.comments ?? []).slice(0, JIRA_COMMENT_LIMIT).reverse();
}

function acceptanceCriteriaSections(issue: JiraIssue): SourceItem["sections"] {
  return Object.entries(issue.names ?? {})
    .filter(
      ([fieldId, name]) =>
        fieldId !== DESCRIPTION_FIELD && ACCEPTANCE_CRITERIA_RE.test(name)
    )
    .map(([fieldId, name]) => ({
      title: name,
      markdown: fieldMarkdown(issue, fieldId),
    }))
    .filter((section) => section.markdown.length > 0);
}

/** Rendered HTML converted to markdown, else the raw value (wiki markup string or ADF). */
function fieldMarkdown(issue: JiraIssue, fieldId: string): string {
  const rendered = issue.renderedFields?.[fieldId];
  if (typeof rendered === "string" && rendered.trim()) {
    return htmlToMarkdown(rendered);
  }
  return rawRichText(issue.fields[fieldId]);
}

function rawRichText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return adfToPlainText(value);
}

function toSourceComment(comment: JiraComment): SourceItemComment {
  const rendered = comment.renderedBody?.trim();
  return {
    id: comment.id,
    parentId: comment.parentId ?? null,
    author: comment.author?.displayName ?? null,
    createdAt: toIsoDate(comment.created),
    bodyMarkdown: rendered
      ? htmlToMarkdown(rendered)
      : rawRichText(comment.body),
  };
}

function toSourceAttachment(attachment: JiraAttachment): SourceItemAttachment {
  return {
    name: attachment.filename ?? `attachment-${attachment.id ?? "unknown"}`,
    url: attachment.content ?? null,
    mimeType: attachment.mimeType ?? null,
    size: attachment.size ?? null,
  };
}

function issueKeyFromUrl(url: URL): string | null {
  const selected = url.searchParams.get(SELECTED_ISSUE_PARAM)?.trim();
  if (selected && ISSUE_KEY_RE.test(selected)) {
    return selected.toUpperCase();
  }
  const segments = url.pathname.split("/").map(decodePathSegment).reverse();
  const key = segments.find((segment) => ISSUE_KEY_RE.test(segment));
  return key ? key.toUpperCase() : null;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function describeManualFailure(key: string, error: JiraError): string {
  if (error.kind === JiraErrorKind.NotFound) {
    return `Jira issue ${key} was not found, or the bot account cannot see it.`;
  }
  return `Could not load Jira issue ${key}: ${error.message}`;
}

function isJiraTriggerType(value: string): value is JiraTriggerType {
  return SUPPORTED_TRIGGER_TYPES.has(value);
}

/** RetryableSourceError for temporary failures, a plain Error otherwise (same message). */
function sourceFailure(message: string, error: JiraError): Error {
  return error.retryable
    ? new RetryableSourceError(message)
    : new Error(message);
}

/** The issue's web links (e.g. the page its plan is reviewed on); none when they cannot be read. */
async function fetchRemoteLinks(
  ctx: JiraContext,
  issue: JiraIssue
): Promise<SourceItemLink[]> {
  const links = await jiraRequest(
    ctx,
    { method: HttpMethod.Get, path: jiraIssuePath(issue.id, "remotelink") },
    jiraRemoteLinksSchema
  );
  if (!links.ok) {
    ctx.log.warn("Could not load Jira web links; importing without them", {
      connectionId: ctx.connection.id,
      issueKey: issue.key,
      status: links.error.status,
      kind: links.error.kind,
    });
    return [];
  }
  return links.value.flatMap((link) =>
    link.object?.url
      ? [{ url: link.object.url, title: link.object.title ?? null }]
      : []
  );
}
