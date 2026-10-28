import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import { type ActionResult, defineAction, HttpMethod } from "../../types";
import { markdownToAdf } from "../atlassian/adf";
import { failed, type JiraActionContext, skipped } from "./actions";
import { attachJiraFile } from "./attachments";
import {
  type JiraError,
  jiraIssueBrowseUrl,
  jiraIssuePath,
  jiraRequest,
  jiraRequestWithoutBody,
} from "./client";
import { JiraActionType, JiraDeployment } from "./constants";
import { jiraProjectSettingsSchema } from "./project";
import {
  type JiraConnectionConfig,
  type JiraIssueLinkType,
  type JiraSecrets,
  jiraCreatedIssueSchema,
  jiraFoundIssuesSchema,
  jiraIssueLinkTypesSchema,
} from "./schemas";

/**
 * jira.create_issue: a new issue in one of the project connection's Jira
 * projects, e.g. the user story a BA run derives from a raw requirement, with
 * the approved PRD as its description. Optionally linked to another issue of
 * those projects (by default the run's source issue) with an issue link
 * named by its phrase as read from the new issue: "implements" makes the new
 * issue implement the other one, "is implemented by" the other way round.
 * A text file (e.g. the full PRD next to a summary as the description) can be
 * attached to the new issue (`attachmentName` + `attachmentContent`).
 * A description longer than a Jira field continues in comments on the new
 * issue ("Description, continued (2/3)"), so an imported issue carries all of
 * it. An external operation: agents get it through a grant on the project
 * connection key (`jira: { allow: [jira.create_issue] }`).
 */

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,254}$/;
const ISSUE_KEY_RE = /^([A-Z][A-Z0-9_]{0,254})-\d+$/;
const SUMMARY_MAX = 255;
const DESCRIPTION_MAX = 200_000;
const ATTACHMENT_CONTENT_MAX = 1_000_000;
const ATTACHMENT_NAME_MAX = 255;
/** A file name, without folders. */
const ATTACHMENT_NAME_RE = /^[^/\\]+$/;
const MARKDOWN_NAME_RE = /\.(md|markdown)$/i;
/**
 * Jira rejects a description or comment over 32 767 characters (on Cloud,
 * of the stored ADF): a longer description continues in comments.
 */
const FIELD_MAX = 30_000;
/** Room left in each piece for the "continued" heading and the joins. */
const PART_BUDGET = FIELD_MAX - 1000;
const FENCE_RE = /^\s*(```|~~~)/;
const ISSUE_TYPE_MAX = 255;
const LINK_PHRASE_MAX = 255;
const LABELS_MAX = 20;
const LABEL_MAX = 255;
const LISTED_LINK_TYPES_MAX = 15;
const DEFAULT_ISSUE_TYPE = "Story";
/** A retry looks for the issue its first attempt created among this many recent ones. */
const RETRY_LOOKUP_MAX = 20;
const LABEL_RE = /^\S+$/;
const JQL_TEXT_OPERATOR_RE = /[^\p{L}\p{N}\s]/gu;

const upperTrimmed = z.string().trim().toUpperCase();

export const jiraCreateIssueConfigSchema = z.object({
  projectKey: upperTrimmed.pipe(z.string().regex(PROJECT_KEY_RE)).nullish(),
  issueType: z
    .string()
    .trim()
    .min(1)
    .max(ISSUE_TYPE_MAX)
    .default(DEFAULT_ISSUE_TYPE),
  summary: z.string().trim().min(1, "Enter the summary").max(SUMMARY_MAX),
  description: z.string().max(DESCRIPTION_MAX).nullish(),
  labels: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(LABEL_MAX)
        .regex(LABEL_RE, "A Jira label has no spaces")
    )
    .max(LABELS_MAX)
    .default([]),
  linkType: z.string().trim().max(LINK_PHRASE_MAX).nullish(),
  attachmentName: z
    .string()
    .trim()
    .max(ATTACHMENT_NAME_MAX)
    .regex(ATTACHMENT_NAME_RE, "Name the file without folders")
    .nullish(),
  attachmentContent: z.string().max(ATTACHMENT_CONTENT_MAX).nullish(),
  linkIssue: upperTrimmed
    .pipe(z.string().regex(ISSUE_KEY_RE, "Enter an issue key like PROJ-123"))
    .nullish(),
});
export type JiraCreateIssueConfig = z.infer<typeof jiraCreateIssueConfigSchema>;

const CREATE_ISSUE_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "projectKey",
    label: "Jira project",
    kind: IntegrationFieldKind.Text,
    placeholder: "PROJ",
    description:
      "Key of one of the project connection's Jira projects; defaults to the run's source issue's project, or the first project.",
  },
  {
    key: "issueType",
    label: "Issue type",
    kind: IntegrationFieldKind.Text,
    defaultValue: DEFAULT_ISSUE_TYPE,
    description: "Name of the issue type, e.g. Story, Task or Bug.",
  },
  {
    key: "summary",
    label: "Summary",
    kind: IntegrationFieldKind.Template,
    required: true,
    placeholder: "{{source.title}}",
  },
  {
    key: "description",
    label: "Description",
    kind: IntegrationFieldKind.Template,
    description:
      "Markdown, e.g. the whole PRD. Jira Cloud shows it as rich text; Data Center shows the text as written.",
  },
  {
    key: "labels",
    label: "Labels",
    kind: IntegrationFieldKind.StringList,
    description: "Labels of the new issue (single words).",
  },
  {
    key: "attachmentName",
    label: "Attachment name",
    kind: IntegrationFieldKind.Text,
    placeholder: "PRD.md",
    description:
      "File name of a text file to attach to the new issue, e.g. the full PRD; needs the attachment content.",
  },
  {
    key: "attachmentContent",
    label: "Attachment content",
    kind: IntegrationFieldKind.Textarea,
    description:
      "The text of the file to attach (Markdown or plain text), as it should be in the file.",
  },
  {
    key: "linkType",
    label: "Link to the issue as",
    kind: IntegrationFieldKind.Text,
    placeholder: "implements",
    description:
      'Issue link phrase as read from the new issue ("implements", "is implemented by", "relates to", "blocks"), or a link type name. Leave it out for no link.',
  },
  {
    key: "linkIssue",
    label: "Linked issue",
    kind: IntegrationFieldKind.Text,
    placeholder: "PROJ-123",
    description:
      "Key of the issue to link to, in one of the project connection's Jira projects; defaults to the run's source issue.",
  },
];

export const jiraCreateIssueAction = defineAction<
  JiraCreateIssueConfig,
  JiraConnectionConfig,
  JiraSecrets
>({
  key: JiraActionType.CreateIssue,
  displayName: "Create a Jira issue",
  description:
    "Creates an issue in one of the project connection's Jira projects, e.g. the user story with the approved PRD as its description, and can link it to the run's source issue.",
  configSchema: jiraCreateIssueConfigSchema,
  configFields: CREATE_ISSUE_FIELDS,
  defaultEvents: [WorkflowRunEvent.Succeeded],
  execute: executeCreateIssue,
});

type IssueLinkPlan = {
  type: JiraIssueLinkType;
  /** The new issue is at the inward end: the type's outward phrase reads from it. */
  newIssueInward: boolean;
  otherKey: string;
};

type Failure = { result: ActionResult };

async function executeCreateIssue(
  ctx: JiraActionContext<JiraCreateIssueConfig>
): Promise<ActionResult> {
  const projectKeys = allowedProjectKeys(ctx);
  if (!projectKeys.ok) {
    return skipped(projectKeys.error);
  }
  const projectKey = chooseProjectKey(ctx, projectKeys.value);
  if (!projectKey.ok) {
    return notAllowed(projectKey.error);
  }
  const link = await planLink(ctx, projectKeys.value);
  if (!link.ok) {
    return link.error.result;
  }
  if (ctx.config.attachmentContent && !ctx.config.attachmentName) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: "Name the attachment (attachmentName) to attach its content.",
      retryable: false,
    };
  }
  const summary = ctx.render(ctx.config.summary).trim().slice(0, SUMMARY_MAX);
  const existing =
    ctx.attempt > 1
      ? await findCreatedBefore(ctx, projectKey.value, summary)
      : null;
  const parts = descriptionParts(ctx);
  const issue =
    existing ?? (await createIssue(ctx, projectKey.value, summary, parts[0]));
  if (!issue.ok) {
    return issue.error.result;
  }
  // A retry that found its issue does not write its content again.
  const completed = await completeIssue(ctx, issue.value, {
    parts: existing ? [] : parts,
    attach: !existing,
    link: link.value,
  });
  if (!completed.ok) {
    return completed.error.result;
  }
  const url = jiraIssueBrowseUrl(
    ctx.connection.config.siteUrl,
    issue.value.key
  );
  return {
    status: WorkflowActionRunStatus.Succeeded,
    externalRef: issue.value.key,
    detail: [
      `Created ${issue.value.key} (${url}) in ${projectKey.value}`,
      link.value
        ? `, which ${describeLink(link.value)} ${link.value.otherKey}`
        : "",
      completed.value ? `; attached ${completed.value}` : "",
      parts.length > 1
        ? `; the description continues in ${parts.length - 1} comment(s)`
        : "",
      ".",
    ].join(""),
  };
}

/** The writes after the issue exists: continuation, attachment, link. The attached file's name. */
async function completeIssue(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  issue: { id: string; key: string },
  plan: { parts: string[]; attach: boolean; link: IssueLinkPlan | null }
): Promise<Result<string | null, Failure>> {
  const continued = await postContinuation(ctx, issue.key, plan.parts);
  if (!continued.ok) {
    return continued;
  }
  const attached: Result<string | null, Failure> = plan.attach
    ? await attachText(ctx, issue)
    : Result.ok(null);
  if (!attached.ok) {
    return attached;
  }
  if (plan.link) {
    const linked = await addIssueLink(ctx, issue.key, plan.link);
    if (!linked.ok) {
      return linked;
    }
  }
  return attached;
}

function allowedProjectKeys(
  ctx: JiraActionContext<JiraCreateIssueConfig>
): Result<string[], string> {
  const settings = jiraProjectSettingsSchema.safeParse(
    ctx.connection.projectSettings ?? {}
  );
  return settings.success
    ? Result.ok(settings.data.projectKeys)
    : Result.err(
        "Jira issues are created through a project connection, which names the Jira projects it may use; this one names none."
      );
}

function chooseProjectKey(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  allowed: string[]
): Result<string, string> {
  const wanted =
    ctx.config.projectKey ??
    sourceProjectKey(ctx, allowed) ??
    allowed[0] ??
    null;
  if (wanted && allowed.includes(wanted)) {
    return Result.ok(wanted);
  }
  return Result.err(
    `Jira project ${wanted ?? "(none)"} is not one of the project connection's projects (${allowed.join(", ")}).`
  );
}

/** The source issue's project when the run came from one of the allowed ones. */
function sourceProjectKey(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  allowed: string[]
): string | null {
  const key = ISSUE_KEY_RE.exec(ctx.run.source.key)?.[1] ?? null;
  return key && allowed.includes(key) ? key : null;
}

async function planLink(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  allowed: string[]
): Promise<Result<IssueLinkPlan | null, Failure>> {
  const phrase = ctx.config.linkType?.trim();
  if (!phrase) {
    return Result.ok(null);
  }
  const otherKey = ctx.config.linkIssue ?? ctx.run.source.key;
  const otherProject = ISSUE_KEY_RE.exec(otherKey)?.[1] ?? "";
  if (!allowed.includes(otherProject)) {
    return Result.err({
      result: notAllowed(
        `${otherKey} is not in one of the project connection's Jira projects (${allowed.join(", ")}).`
      ),
    });
  }
  const listed = await jiraRequest(
    ctx,
    { method: HttpMethod.Get, path: "issueLinkType" },
    jiraIssueLinkTypesSchema
  );
  if (!listed.ok) {
    return Result.err({
      result: failed(ctx, listed.error, "list the issue link types"),
    });
  }
  const types = listed.value.issueLinkTypes ?? [];
  const match = matchLinkType(types, phrase);
  if (!match) {
    return Result.err({
      result: {
        status: WorkflowActionRunStatus.Failed,
        error: `This Jira site has no issue link "${phrase}" (available: ${describeLinkTypes(types)}). A Jira admin adds link types under Settings → Issues → Issue linking.`,
        retryable: false,
      },
    });
  }
  return Result.ok({ ...match, otherKey });
}

/** Outward phrase or type name first (the new issue reads it), then the inward phrase. */
function matchLinkType(
  types: JiraIssueLinkType[],
  phrase: string
): Pick<IssueLinkPlan, "type" | "newIssueInward"> | null {
  const wanted = normalize(phrase);
  const outward = types.find(
    (type) =>
      normalize(type.outward) === wanted || normalize(type.name) === wanted
  );
  if (outward) {
    return { type: outward, newIssueInward: true };
  }
  const inward = types.find((type) => normalize(type.inward) === wanted);
  return inward ? { type: inward, newIssueInward: false } : null;
}

async function createIssue(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  projectKey: string,
  summary: string,
  description: string | undefined
): Promise<Result<{ id: string; key: string }, Failure>> {
  const created = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: "issue",
      body: {
        fields: {
          project: { key: projectKey },
          issuetype: { name: ctx.config.issueType },
          summary,
          ...(description
            ? {
                description: descriptionBody(
                  ctx.connection.config,
                  description
                ),
              }
            : {}),
          ...(ctx.config.labels.length > 0
            ? { labels: ctx.config.labels }
            : {}),
        },
      },
    },
    jiraCreatedIssueSchema
  );
  return created.ok
    ? Result.ok(created.value)
    : Result.err({
        result: failed(ctx, created.error, `create the issue in ${projectKey}`),
      });
}

/** A retry finds the issue an earlier attempt created: the bot's newest one with this summary. */
async function findCreatedBefore(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  projectKey: string,
  summary: string
): Promise<Result<{ id: string; key: string }, Failure> | null> {
  const cloud = ctx.connection.config.deployment === JiraDeployment.Cloud;
  const found = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: cloud ? "search/jql" : "search",
      query: {
        jql: `project = "${projectKey}" AND reporter = currentUser() AND created >= "-1d" AND summary ~ "${searchTerms(summary)}" ORDER BY created DESC`,
        fields: "summary",
        maxResults: RETRY_LOOKUP_MAX,
      },
    },
    jiraFoundIssuesSchema
  );
  if (!found.ok) {
    return null;
  }
  const issue = (found.value.issues ?? []).find(
    (candidate) => candidate.fields?.summary?.trim() === summary
  );
  return issue ? Result.ok({ id: issue.id, key: issue.key }) : null;
}

async function addIssueLink(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  newKey: string,
  link: IssueLinkPlan
): Promise<Result<null, Failure>> {
  // Jira reads the type's outward phrase from the inward issue: inward "implements" outward.
  const [inward, outward] = link.newIssueInward
    ? [newKey, link.otherKey]
    : [link.otherKey, newKey];
  const linked = await jiraRequestWithoutBody(ctx, {
    method: HttpMethod.Post,
    path: "issueLink",
    body: {
      type: { id: link.type.id },
      inwardIssue: { key: inward },
      outwardIssue: { key: outward },
    },
  });
  if (linked.ok) {
    return Result.ok(null);
  }
  return Result.err(
    afterCreation(
      ctx,
      newKey,
      linked.error,
      `link ${newKey} to ${link.otherKey}`
    )
  );
}

/** The configured text file on the new issue; the attached file's name, or null for none. */
async function attachText(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  issue: { id: string; key: string }
): Promise<Result<string | null, Failure>> {
  const { attachmentName: name, attachmentContent: content } = ctx.config;
  if (!(name && content)) {
    return Result.ok(null);
  }
  const contentType = MARKDOWN_NAME_RE.test(name)
    ? "text/markdown"
    : "text/plain";
  const attached = await attachJiraFile(
    ctx,
    {
      provider: IntegrationProviderKey.Jira,
      externalId: issue.id,
      key: issue.key,
      url: null,
      title: null,
      container: null,
    },
    { name, contentType, bytes: new TextEncoder().encode(content) }
  );
  if (attached.ok) {
    return Result.ok(attached.value.name);
  }
  return Result.err({
    result: {
      status: WorkflowActionRunStatus.Failed,
      error: `Created ${issue.key}, but ${lowerFirst(attached.error.message)}`,
      retryable: false,
    },
  });
}

async function postContinuation(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  key: string,
  parts: string[]
): Promise<Result<null, Failure>> {
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      continue;
    }
    const text = `Description, continued (${index + 1}/${parts.length}):\n\n${part}`;
    const posted = await jiraRequestWithoutBody(ctx, {
      method: HttpMethod.Post,
      path: jiraIssuePath(key, "comment"),
      body: { body: descriptionBody(ctx.connection.config, text) },
    });
    if (!posted.ok) {
      return Result.err(
        afterCreation(
          ctx,
          key,
          posted.error,
          `continue the description of ${key}`
        )
      );
    }
  }
  return Result.ok(null);
}

/** A write after the issue exists failed: final, so a retry does not create it again. */
function afterCreation(
  ctx: JiraActionContext<JiraCreateIssueConfig>,
  key: string,
  error: JiraError,
  attempted: string
): Failure {
  const result = failed(ctx, error, attempted);
  return {
    result:
      result.status === WorkflowActionRunStatus.Failed
        ? {
            ...result,
            error: `Created ${key}, but ${lowerFirst(result.error)}`,
            retryable: false,
          }
        : result,
  };
}

function descriptionBody(config: JiraConnectionConfig, text: string) {
  return config.deployment === JiraDeployment.Cloud
    ? markdownToAdf(text)
    : text;
}

function describeLink(link: IssueLinkPlan): string {
  return link.newIssueInward ? link.type.outward : link.type.inward;
}

function describeLinkTypes(types: JiraIssueLinkType[]): string {
  if (types.length === 0) {
    return "none";
  }
  const phrases = types.map((type) => `${type.outward} / ${type.inward}`);
  const listed = phrases.slice(0, LISTED_LINK_TYPES_MAX).join(", ");
  return phrases.length > LISTED_LINK_TYPES_MAX ? `${listed}, …` : listed;
}

function notAllowed(reason: string): ActionResult {
  return {
    status: WorkflowActionRunStatus.Failed,
    error: `Not allowed: ${reason}`,
    retryable: false,
  };
}

/** The summary's words, without the characters Jira text search treats as operators. */
function searchTerms(summary: string): string {
  return summary.replaceAll(JQL_TEXT_OPERATOR_RE, " ").trim();
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * The rendered description in pieces that each fit a Jira field: whole
 * paragraphs (a fenced code block counts as one), a paragraph too long for
 * one field by lines. One piece, or none for no description.
 */
function descriptionParts(
  ctx: JiraActionContext<JiraCreateIssueConfig>
): string[] {
  const text = ctx.config.description
    ? ctx.render(ctx.config.description).trim()
    : "";
  if (!text) {
    return [];
  }
  const size = (value: string) =>
    ctx.connection.config.deployment === JiraDeployment.Cloud
      ? JSON.stringify(markdownToAdf(value)).length
      : value.length;
  if (size(text) <= FIELD_MAX) {
    return [text];
  }
  const blocks = markdownBlocks(text).flatMap((block) => fitBlock(block, size));
  return packBlocks(blocks, size);
}

function packBlocks(
  blocks: string[],
  size: (value: string) => number
): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentSize = 0;
  for (const block of blocks) {
    const blockSize = size(block);
    if (current.length > 0 && currentSize + blockSize > PART_BUDGET) {
      parts.push(current.join("\n\n"));
      current = [];
      currentSize = 0;
    }
    current.push(block);
    currentSize += blockSize;
  }
  if (current.length > 0) {
    parts.push(current.join("\n\n"));
  }
  return parts;
}

/** Paragraphs split at blank lines outside fenced code blocks. */
function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
    }
    if (!fenced && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

/** A block over the budget, by lines (a line over it is cut). */
function fitBlock(block: string, size: (value: string) => number): string[] {
  if (size(block) <= PART_BUDGET) {
    return [block];
  }
  const pieces: string[] = [];
  let current: string[] = [];
  for (const line of block.split("\n")) {
    if (
      current.length > 0 &&
      size([...current, line].join("\n")) > PART_BUDGET
    ) {
      pieces.push(current.join("\n"));
      current = [];
    }
    current.push(line.slice(0, PART_BUDGET / 2));
  }
  if (current.length > 0) {
    pieces.push(current.join("\n"));
  }
  return pieces;
}
