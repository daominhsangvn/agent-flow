import type { JsonObject } from "@repo/api/src/types/common";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import {
  type ActionContext,
  type ActionResult,
  defineAction,
  HttpMethod,
} from "../../types";
import { writeBody } from "./bodies";
import {
  type ConfluenceContext,
  ConfluenceErrorKind,
  confluenceRequest,
} from "./client";
import {
  ConfluenceActionType,
  ConfluenceBodyFormat,
  ConfluenceCommentKind,
} from "./constants";
import {
  type AllowedSpaces,
  findSpaceByKey,
  loadAllowedPage,
  loadAllowedSpaces,
  type OperationFailure,
  pageWebUrl,
  parsePageReference,
  toFailure,
} from "./pages";
import { openPage } from "./reads";
import {
  type ConfluenceComment,
  type ConfluenceConnectionConfig,
  type ConfluencePage,
  type ConfluenceSecrets,
  confluenceCommentSchema,
  confluenceCreatedSchema,
  confluenceListSchema,
  confluencePageSchema,
} from "./schemas";

/**
 * What agents and workflow actions write to Confluence, within the project
 * connection's spaces: new pages (e.g. publish a plan for review), page
 * updates that never overwrite someone else's edit (`baseVersion`),
 * comments and replies, and resolving inline comments once addressed.
 */

const TITLE_MAX = 255;
const BODY_MAX = 500_000;
const REFERENCE_MAX = 2048;
const MESSAGE_MAX = 500;
const RESOLVED_STATUS = "resolved";

const referenceSchema = z.string().trim().min(1).max(REFERENCE_MAX);
const formatSchema = z
  .enum(ConfluenceBodyFormat)
  .default(ConfluenceBodyFormat.Markdown);

export const confluenceCreatePageConfigSchema = z.object({
  space: z.string().trim().min(1).max(TITLE_MAX),
  title: z.string().trim().min(1).max(TITLE_MAX),
  body: z.string().min(1).max(BODY_MAX),
  parentId: z.string().trim().max(REFERENCE_MAX).nullish(),
  format: formatSchema,
});
export type ConfluenceCreatePageConfig = z.infer<
  typeof confluenceCreatePageConfigSchema
>;

export const confluenceUpdatePageConfigSchema = z.object({
  page: referenceSchema,
  baseVersion: z.coerce.number().int().positive(),
  title: z.string().trim().max(TITLE_MAX).nullish(),
  body: z.string().min(1).max(BODY_MAX),
  format: formatSchema,
  message: z.string().trim().max(MESSAGE_MAX).nullish(),
});
export type ConfluenceUpdatePageConfig = z.infer<
  typeof confluenceUpdatePageConfigSchema
>;

export const confluenceCommentConfigSchema = z.object({
  page: referenceSchema,
  body: z.string().min(1).max(BODY_MAX),
  replyTo: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .nullish(),
});
export type ConfluenceCommentConfig = z.infer<
  typeof confluenceCommentConfigSchema
>;

export const confluenceResolveCommentConfigSchema = z.object({
  page: referenceSchema,
  comment: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().min(1).max(REFERENCE_MAX)),
});
export type ConfluenceResolveCommentConfig = z.infer<
  typeof confluenceResolveCommentConfigSchema
>;

const PAGE_FIELD: IntegrationFieldDescriptor = {
  key: "page",
  label: "Page",
  kind: IntegrationFieldKind.Text,
  required: true,
  placeholder:
    "https://your-company.atlassian.net/wiki/spaces/ENG/pages/123456",
  description: "The page's link or id.",
};

const FORMAT_FIELD: IntegrationFieldDescriptor = {
  key: "format",
  label: "Body format",
  kind: IntegrationFieldKind.Select,
  defaultValue: ConfluenceBodyFormat.Markdown,
  options: [
    { value: ConfluenceBodyFormat.Markdown, label: "Markdown" },
    { value: ConfluenceBodyFormat.Storage, label: "Storage format (XHTML)" },
  ],
  description:
    "markdown (default), or storage for a body read with format storage (keeps macros and inline comment markers).",
};

const CREATE_PAGE_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "space",
    label: "Space",
    kind: IntegrationFieldKind.Text,
    required: true,
    placeholder: "ENG",
    description: "Key of one of the project connection's spaces.",
  },
  {
    key: "title",
    label: "Title",
    kind: IntegrationFieldKind.Template,
    required: true,
    placeholder: "{{source.key}} Implementation plan",
    description: "Unique within the space.",
  },
  {
    key: "body",
    label: "Body",
    kind: IntegrationFieldKind.Template,
    required: true,
    placeholder: "{{plan}}",
    description:
      "The page's content (Markdown unless the format says storage).",
  },
  {
    key: "parentId",
    label: "Parent page",
    kind: IntegrationFieldKind.Text,
    placeholder: "123456",
    description:
      "Link or id of the page to put it under, in the same space; defaults to the project connection's parent page.",
  },
  FORMAT_FIELD,
];

const UPDATE_PAGE_FIELDS: IntegrationFieldDescriptor[] = [
  PAGE_FIELD,
  {
    key: "baseVersion",
    label: "Version read",
    kind: IntegrationFieldKind.Number,
    required: true,
    placeholder: "7",
    description:
      "The page version your change is based on (from confluence_get_page). Refused when the page changed since, so nobody's edit is overwritten: read it again.",
  },
  {
    key: "title",
    label: "Title",
    kind: IntegrationFieldKind.Template,
    description: "A new title; leave it out to keep the title.",
  },
  {
    key: "body",
    label: "Body",
    kind: IntegrationFieldKind.Template,
    required: true,
    description: "The page's whole new content.",
  },
  FORMAT_FIELD,
  {
    key: "message",
    label: "Change note",
    kind: IntegrationFieldKind.Text,
    placeholder: "Addressed the review comments",
    description: "Shown in the page history.",
  },
];

const COMMENT_FIELDS: IntegrationFieldDescriptor[] = [
  PAGE_FIELD,
  {
    key: "body",
    label: "Comment",
    kind: IntegrationFieldKind.Template,
    required: true,
    description: "Markdown.",
  },
  {
    key: "replyTo",
    label: "Reply to",
    kind: IntegrationFieldKind.Text,
    placeholder: "98765",
    description:
      "Id of a comment of the page (from confluence_list_comments) to reply to; leave it out for a new comment below the page.",
  },
];

const RESOLVE_COMMENT_FIELDS: IntegrationFieldDescriptor[] = [
  PAGE_FIELD,
  {
    key: "comment",
    label: "Inline comment",
    kind: IntegrationFieldKind.Text,
    required: true,
    placeholder: "98765",
    description:
      "Id of the inline comment (the first comment of its thread) to resolve.",
  },
];

type ConfluenceActionContext<TConfig> = ActionContext<
  TConfig,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>;

export const confluenceCreatePageAction = defineAction<
  ConfluenceCreatePageConfig,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>({
  key: ConfluenceActionType.CreatePage,
  displayName: "Create a Confluence page",
  description:
    "Creates a page in one of the project connection's spaces, e.g. the implementation plan for review.",
  configSchema: confluenceCreatePageConfigSchema,
  configFields: CREATE_PAGE_FIELDS,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: (ctx) => settle(() => createPage(ctx)),
});

export const confluenceUpdatePageAction = defineAction<
  ConfluenceUpdatePageConfig,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>({
  key: ConfluenceActionType.UpdatePage,
  displayName: "Update a Confluence page",
  description:
    "Replaces the body (and optionally the title) of a page of the project connection's spaces, unless it changed since the version read.",
  configSchema: confluenceUpdatePageConfigSchema,
  configFields: UPDATE_PAGE_FIELDS,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: (ctx) => settle(() => updatePage(ctx)),
});

export const confluenceCommentAction = defineAction<
  ConfluenceCommentConfig,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>({
  key: ConfluenceActionType.Comment,
  displayName: "Comment on a Confluence page",
  description:
    "Adds a comment below a page of the project connection's spaces, or replies to one of its comments.",
  configSchema: confluenceCommentConfigSchema,
  configFields: COMMENT_FIELDS,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: (ctx) => settle(() => comment(ctx)),
});

export const confluenceResolveCommentAction = defineAction<
  ConfluenceResolveCommentConfig,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>({
  key: ConfluenceActionType.ResolveComment,
  displayName: "Resolve a Confluence inline comment",
  description:
    "Marks an inline comment of a page of the project connection's spaces resolved. Resolving a resolved one is not an error.",
  configSchema: confluenceResolveCommentConfigSchema,
  configFields: RESOLVE_COMMENT_FIELDS,
  defaultEvents: [WorkflowRunEvent.PlanReady],
  execute: (ctx) => settle(() => resolveComment(ctx)),
});

export const CONFLUENCE_ACTIONS = [
  confluenceCreatePageAction,
  confluenceUpdatePageAction,
  confluenceCommentAction,
  confluenceResolveCommentAction,
];

type Done = { externalRef: string; detail: string };

async function createPage(
  ctx: ConfluenceActionContext<ConfluenceCreatePageConfig>
): Promise<Result<Done, OperationFailure>> {
  const spaces = await loadAllowedSpaces(ctx);
  if (!spaces.ok) {
    return spaces;
  }
  const space = findSpaceByKey(spaces.value, ctx.config.space);
  if (!space) {
    return Result.err({
      error: `Not allowed: space ${ctx.config.space} is not one of the project connection's spaces (${spaces.value.keys.join(", ")}).`,
      retryable: false,
    });
  }
  const parent = await resolveParent(ctx, spaces.value, space.id);
  if (!parent.ok) {
    return parent;
  }
  const title = ctx.render(ctx.config.title).trim().slice(0, TITLE_MAX);
  // A retry finds the page its first attempt created.
  const existing =
    ctx.attempt > 1 ? await findPageByTitle(ctx, space.id, title) : null;
  if (existing) {
    return Result.ok(created(ctx, existing, "Found the page created before"));
  }
  const result = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: "api/v2/pages",
      body: {
        spaceId: space.id,
        status: "current",
        title,
        ...(parent.value ? { parentId: parent.value } : {}),
        body: writeBody(ctx.config.format, ctx.render(ctx.config.body)),
      },
    },
    confluenceCreatedSchema
  );
  return result.ok
    ? Result.ok(created(ctx, result.value, `Created the page "${title}"`))
    : Result.err(toFailure(result.error));
}

async function updatePage(
  ctx: ConfluenceActionContext<ConfluenceUpdatePageConfig>
): Promise<Result<Done, OperationFailure>> {
  const opened = await openPage(ctx, ctx.config.page);
  if (!opened.ok) {
    return opened;
  }
  const { page } = opened.value;
  const base = ctx.config.baseVersion;
  const url = pageWebUrl(ctx.connection.config, page);
  if (page.version.number !== base) {
    // A retry of this very update finds it done.
    const ownRetry =
      ctx.attempt > 1 &&
      page.version.number === base + 1 &&
      page.version.authorId === ctx.connection.account?.externalAccountId;
    return ownRetry
      ? Result.ok({ externalRef: url, detail: `Updated "${page.title}"` })
      : Result.err(changedSince(page, base));
  }
  const title = ctx.config.title
    ? ctx.render(ctx.config.title).trim().slice(0, TITLE_MAX)
    : "";
  const result = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Put,
      path: `api/v2/pages/${page.id}`,
      body: {
        id: page.id,
        status: "current",
        title: title || page.title,
        body: writeBody(ctx.config.format, ctx.render(ctx.config.body)),
        version: {
          number: base + 1,
          ...(ctx.config.message ? { message: ctx.config.message } : {}),
        },
      },
    },
    confluencePageSchema
  );
  if (!result.ok) {
    return Result.err(
      result.error.kind === ConfluenceErrorKind.Conflict
        ? changedSince(page, base)
        : toFailure(result.error)
    );
  }
  return Result.ok({
    externalRef: url,
    detail: `Updated "${result.value.title}" to version ${result.value.version.number}`,
  });
}

async function comment(
  ctx: ConfluenceActionContext<ConfluenceCommentConfig>
): Promise<Result<Done, OperationFailure>> {
  const opened = await openPage(ctx, ctx.config.page);
  if (!opened.ok) {
    return opened;
  }
  const { page } = opened.value;
  const body = writeBody(
    ConfluenceBodyFormat.Markdown,
    ctx.render(ctx.config.body)
  );
  let request: { path: string; body: JsonObject };
  if (ctx.config.replyTo) {
    const parent = await loadPageComment(ctx, page, ctx.config.replyTo);
    if (!parent.ok) {
      return parent;
    }
    request = {
      path: `api/v2/${parent.value.kind}-comments`,
      body: { parentCommentId: parent.value.comment.id, body },
    };
  } else {
    request = {
      path: `api/v2/${ConfluenceCommentKind.Footer}-comments`,
      body: { pageId: page.id, body },
    };
  }
  const result = await confluenceRequest(
    ctx,
    { method: HttpMethod.Post, path: request.path, body: request.body },
    confluenceCreatedSchema
  );
  return result.ok
    ? Result.ok({
        externalRef: result.value.id,
        detail: `Commented on "${page.title}"`,
      })
    : Result.err(toFailure(result.error));
}

async function resolveComment(
  ctx: ConfluenceActionContext<ConfluenceResolveCommentConfig>
): Promise<Result<Done, OperationFailure>> {
  const opened = await openPage(ctx, ctx.config.page);
  if (!opened.ok) {
    return opened;
  }
  const { page } = opened.value;
  const found = await loadComment(
    ctx,
    ConfluenceCommentKind.Inline,
    ctx.config.comment
  );
  if (!found.ok) {
    return found;
  }
  const inline = found.value;
  if (!inline || inline.pageId !== page.id) {
    return Result.err(notOnPage(ctx.config.comment, page, "inline comment"));
  }
  const reference = `${pageWebUrl(ctx.connection.config, page)}?focusedCommentId=${inline.id}`;
  if (inline.resolutionStatus === RESOLVED_STATUS) {
    return Result.ok({ externalRef: reference, detail: "Already resolved" });
  }
  const result = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Put,
      path: `api/v2/inline-comments/${inline.id}`,
      body: {
        version: { number: inline.version.number + 1 },
        body: {
          representation: "storage",
          value: inline.body?.storage?.value ?? "",
        },
        resolved: true,
      },
    },
    confluenceCommentSchema
  );
  return result.ok
    ? Result.ok({ externalRef: reference, detail: "Resolved the comment" })
    : Result.err(toFailure(result.error));
}

/** The parent page id of a new page: the one given, else the project's. */
async function resolveParent(
  ctx: ConfluenceActionContext<ConfluenceCreatePageConfig>,
  spaces: AllowedSpaces,
  spaceId: string
): Promise<Result<string | null, OperationFailure>> {
  const reference = ctx.config.parentId?.trim() || spaces.parentPageId;
  if (!reference) {
    return Result.ok(null);
  }
  const id = parsePageReference(ctx.connection.config, reference);
  if (!id.ok) {
    return Result.err({ error: id.error, retryable: false });
  }
  const parent = await loadAllowedPage(ctx, spaces, id.value);
  if (!parent.ok) {
    return parent;
  }
  return parent.value.spaceId === spaceId
    ? Result.ok(parent.value.id)
    : Result.err({
        error: `The parent page "${parent.value.title}" is in another space than ${ctx.config.space}.`,
        retryable: false,
      });
}

async function findPageByTitle(
  ctx: ConfluenceContext,
  spaceId: string,
  title: string
): Promise<{ id: string; _links?: ConfluencePage["_links"] } | null> {
  const listed = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: "api/v2/pages",
      query: { "space-id": spaceId, title, limit: 1 },
    },
    confluenceListSchema
  );
  const first = listed.ok
    ? confluenceCreatedSchema.safeParse(listed.value.results[0])
    : null;
  return first?.success ? first.data : null;
}

/** A comment of the page, footer or inline, to reply to. */
async function loadPageComment(
  ctx: ConfluenceContext,
  page: ConfluencePage,
  commentId: string
): Promise<
  Result<
    { kind: ConfluenceCommentKind; comment: ConfluenceComment },
    OperationFailure
  >
> {
  for (const kind of Object.values(ConfluenceCommentKind)) {
    const found = await loadComment(ctx, kind, commentId);
    if (!found.ok) {
      return found;
    }
    if (found.value) {
      return found.value.pageId === page.id
        ? Result.ok({ kind, comment: found.value })
        : Result.err(notOnPage(commentId, page, "comment"));
    }
  }
  return Result.err(notOnPage(commentId, page, "comment"));
}

/** The comment; null when there is no such comment of this kind. */
async function loadComment(
  ctx: ConfluenceContext,
  kind: ConfluenceCommentKind,
  commentId: string
): Promise<Result<ConfluenceComment | null, OperationFailure>> {
  if (!COMMENT_ID_RE.test(commentId)) {
    return Result.err({
      error: `"${commentId}" is not a comment id.`,
      retryable: false,
    });
  }
  const found = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `api/v2/${kind}-comments/${commentId}`,
      query: { "body-format": "storage" },
    },
    confluenceCommentSchema
  );
  if (found.ok) {
    return Result.ok(found.value);
  }
  return found.error.kind === ConfluenceErrorKind.NotFound
    ? Result.ok(null)
    : Result.err(toFailure(found.error));
}

const COMMENT_ID_RE = /^\d{1,20}$/;

function created(
  ctx: ConfluenceContext,
  page: { id: string; _links?: ConfluencePage["_links"] },
  detail: string
): Done {
  return {
    externalRef: pageWebUrl(ctx.connection.config, page),
    detail,
  };
}

function changedSince(page: ConfluencePage, base: number): OperationFailure {
  return {
    error: `"${page.title}" changed since version ${base} (it is at version ${page.version.number}): read it again with confluence_get_page and redo your change on the current content.`,
    retryable: false,
  };
}

function notOnPage(
  commentId: string,
  page: ConfluencePage,
  what: string
): OperationFailure {
  return {
    error: `There is no ${what} ${commentId} on "${page.title}".`,
    retryable: false,
  };
}

/** An action's outcome; never throws. */
async function settle(
  write: () => Promise<Result<Done, OperationFailure>>
): Promise<ActionResult> {
  try {
    const result = await write();
    return result.ok
      ? {
          status: WorkflowActionRunStatus.Succeeded,
          externalRef: result.value.externalRef,
          detail: result.value.detail,
        }
      : {
          status: WorkflowActionRunStatus.Failed,
          error: result.error.error,
          retryable: result.error.retryable,
        };
  } catch (error) {
    return {
      status: WorkflowActionRunStatus.Failed,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}
