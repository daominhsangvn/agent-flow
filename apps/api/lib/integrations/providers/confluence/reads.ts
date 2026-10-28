import type { JsonObject } from "@repo/api/src/types/common";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import {
  HttpMethod,
  type IntegrationReadDefinition,
  type ReadResult,
} from "../../types";
import { BODY_MAX, COMMENT_BODY_MAX, readBody } from "./bodies";
import {
  type ConfluenceContext,
  confluenceRequest,
  confluenceWebUrl,
  nextPagePath,
} from "./client";
import {
  ConfluenceBodyFormat,
  ConfluenceCommentFilter,
  ConfluenceCommentKind,
  ConfluenceReadType,
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
import {
  type ConfluenceComment,
  type ConfluenceConnectionConfig,
  type ConfluencePage,
  type ConfluenceSecrets,
  confluenceCommentSchema,
  confluenceListSchema,
  confluenceSearchSchema,
} from "./schemas";

/**
 * What agents read from Confluence (`confluence_get_page`,
 * `confluence_find_pages`, `confluence_list_comments`), always within the
 * project connection's spaces: e.g. the plan page a ticket links to, and the
 * comments reviewers left on it.
 */

const REFERENCE_MAX = 2048;
const TITLE_MAX = 255;
const SEARCH_LIMIT = 25;
const COMMENTS_LIMIT = 100;
/** Bounds the comment threads read at 50, each with its replies. */
const THREADS_MAX = 50;
const LIST_PAGES_MAX = 3;
const RESOLVED_STATUS = "resolved";
const CQL_SPECIAL_RE = /["\\]/g;

const pageReferenceSchema = z.string().trim().min(1).max(REFERENCE_MAX);
const formatSchema = z
  .enum(ConfluenceBodyFormat)
  .default(ConfluenceBodyFormat.Markdown);

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
    "markdown (default) to read the page; storage to edit it in place with confluence_update_page, keeping its macros and inline comment markers.",
};

const getPageInputSchema = z.object({
  page: pageReferenceSchema,
  format: formatSchema,
});
type GetPageInput = z.infer<typeof getPageInputSchema>;

const findPagesInputSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  space: z.string().trim().max(TITLE_MAX).nullish(),
});
type FindPagesInput = z.infer<typeof findPagesInputSchema>;

const listCommentsInputSchema = z.object({
  page: pageReferenceSchema,
  status: z.enum(ConfluenceCommentFilter).default(ConfluenceCommentFilter.Open),
});
type ListCommentsInput = z.infer<typeof listCommentsInputSchema>;

type ConfluenceRead<TInput> = IntegrationReadDefinition<
  TInput,
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>;

export const confluenceGetPageRead: ConfluenceRead<GetPageInput> = {
  key: ConfluenceReadType.GetPage,
  displayName: "Read a Confluence page",
  description:
    "Reads a page of the project's spaces: title, space, version, parent and body (Markdown, or storage format to edit it). Pass the version to confluence_update_page.",
  inputSchema: getPageInputSchema,
  inputFields: [PAGE_FIELD, FORMAT_FIELD],
  execute: (ctx, input) =>
    settle(async () => {
      const opened = await openPage(ctx, input.page);
      if (!opened.ok) {
        return opened;
      }
      const { page, spaces } = opened.value;
      const { body, truncated } = readBody(
        page.body?.storage?.value,
        input.format,
        BODY_MAX
      );
      return Result.ok({
        id: page.id,
        title: page.title,
        space: spaces.byId.get(page.spaceId)?.key ?? null,
        version: page.version.number,
        parentId: page.parentId ?? null,
        url: pageWebUrl(ctx.connection.config, page),
        format: input.format,
        body,
        truncated,
      });
    }),
};

export const confluenceFindPagesRead: ConfluenceRead<FindPagesInput> = {
  key: ConfluenceReadType.FindPages,
  displayName: "Find Confluence pages by title",
  description:
    "Finds pages of the project's spaces whose title contains the words given, e.g. the plan page of a ticket.",
  inputSchema: findPagesInputSchema,
  inputFields: [
    {
      key: "title",
      label: "Title",
      kind: IntegrationFieldKind.Text,
      required: true,
      placeholder: "PROJ-7 Implementation plan",
      description: "Words of the title.",
    },
    {
      key: "space",
      label: "Space",
      kind: IntegrationFieldKind.Text,
      placeholder: "ENG",
      description:
        "A space key of the project connection; leave it out to search all of them.",
    },
  ],
  execute: (ctx, input) =>
    settle(async () => {
      const spaces = await loadAllowedSpaces(ctx);
      if (!spaces.ok) {
        return spaces;
      }
      const keys = searchSpaceKeys(spaces.value, input.space ?? null);
      if (!keys.ok) {
        return keys;
      }
      const found = await confluenceRequest(
        ctx,
        {
          method: HttpMethod.Get,
          path: "rest/api/content/search",
          query: {
            cql: `type = page AND space in (${keys.value.map(cqlString).join(", ")}) AND title ~ ${cqlString(input.title)}`,
            limit: SEARCH_LIMIT,
            expand: "space,version",
          },
        },
        confluenceSearchSchema
      );
      if (!found.ok) {
        return Result.err(toFailure(found.error));
      }
      const allowed = new Set(keys.value.map((key) => key.toUpperCase()));
      return Result.ok({
        pages: found.value.results
          .filter((page) => allowed.has(page.space?.key.toUpperCase() ?? ""))
          .map((page) => ({
            id: page.id,
            title: page.title,
            space: page.space?.key ?? null,
            version: page.version?.number ?? null,
            url:
              confluenceWebUrl(ctx.connection.config, page._links?.webui) ??
              null,
          })),
      });
    }),
};

export const confluenceListCommentsRead: ConfluenceRead<ListCommentsInput> = {
  key: ConfluenceReadType.ListComments,
  displayName: "Read the comments of a Confluence page",
  description:
    "Reads the comment threads of a page of the project's spaces: comments below the page and inline comments on highlighted text (open or resolved), each with its replies and whether you wrote it (mine).",
  inputSchema: listCommentsInputSchema,
  inputFields: [
    PAGE_FIELD,
    {
      key: "status",
      label: "Threads",
      kind: IntegrationFieldKind.Select,
      defaultValue: ConfluenceCommentFilter.Open,
      options: [
        { value: ConfluenceCommentFilter.Open, label: "Open" },
        { value: ConfluenceCommentFilter.All, label: "All" },
      ],
      description:
        "open (default): page comments and unresolved inline comments; all: resolved inline comments too.",
    },
  ],
  execute: (ctx, input) =>
    settle(async () => {
      const opened = await openPage(ctx, input.page);
      if (!opened.ok) {
        return opened;
      }
      const { page } = opened.value;
      const threads: JsonObject[] = [];
      for (const kind of Object.values(ConfluenceCommentKind)) {
        const read = await readThreads(ctx, {
          path: `api/v2/pages/${page.id}/${kind}-comments`,
          kind,
          status: input.status,
          max: THREADS_MAX - threads.length,
        });
        if (!read.ok) {
          return read;
        }
        threads.push(...read.value);
      }
      return Result.ok({
        page: { id: page.id, title: page.title, version: page.version.number },
        threads,
      });
    }),
};

export const CONFLUENCE_READS = [
  confluenceGetPageRead,
  confluenceFindPagesRead,
  confluenceListCommentsRead,
];

/** The page behind a reference, in an allowed space. */
export async function openPage(
  ctx: ConfluenceContext,
  reference: string
): Promise<
  Result<{ page: ConfluencePage; spaces: AllowedSpaces }, OperationFailure>
> {
  const pageId = parsePageReference(ctx.connection.config, reference);
  if (!pageId.ok) {
    return Result.err({ error: pageId.error, retryable: false });
  }
  const spaces = await loadAllowedSpaces(ctx);
  if (!spaces.ok) {
    return spaces;
  }
  const page = await loadAllowedPage(ctx, spaces.value, pageId.value);
  return page.ok ? Result.ok({ page: page.value, spaces: spaces.value }) : page;
}

/** The threads of one kind of comment: each root with its replies. */
async function readThreads(
  ctx: ConfluenceContext,
  options: {
    path: string;
    kind: ConfluenceCommentKind;
    status: ConfluenceCommentFilter;
    max: number;
  }
): Promise<Result<JsonObject[], OperationFailure>> {
  const roots = await listComments(ctx, options.path);
  if (!roots.ok) {
    return roots;
  }
  const shown = roots.value.filter(
    (root) =>
      options.status === ConfluenceCommentFilter.All ||
      root.resolutionStatus !== RESOLVED_STATUS
  );
  const threads: JsonObject[] = [];
  for (const root of shown.slice(0, Math.max(0, options.max))) {
    const replies = await listComments(
      ctx,
      `api/v2/${options.kind}-comments/${root.id}/children`
    );
    if (!replies.ok) {
      return replies;
    }
    threads.push({
      id: root.id,
      kind: options.kind,
      status: root.resolutionStatus === RESOLVED_STATUS ? "resolved" : "open",
      highlighted: root.properties?.inlineOriginalSelection ?? null,
      comments: [root, ...replies.value].map((comment) =>
        toCommentOutput(ctx, comment)
      ),
    });
  }
  return Result.ok(threads);
}

/** A read's outcome; never throws. */
async function settle(
  read: () => Promise<Result<JsonObject, OperationFailure>>
): Promise<ReadResult> {
  try {
    const result = await read();
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, ...result.error };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

async function listComments(
  ctx: ConfluenceContext,
  path: string
): Promise<Result<ConfluenceComment[], OperationFailure>> {
  const comments: ConfluenceComment[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < LIST_PAGES_MAX; page++) {
    const listed = await confluenceRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: next,
        query:
          page === 0
            ? { "body-format": "storage", limit: COMMENTS_LIMIT }
            : undefined,
      },
      confluenceListSchema
    );
    if (!listed.ok) {
      return Result.err(toFailure(listed.error));
    }
    for (const value of listed.value.results) {
      const comment = confluenceCommentSchema.safeParse(value);
      if (comment.success) {
        comments.push(comment.data);
      }
    }
    next = nextPagePath(listed.value._links?.next);
  }
  return Result.ok(comments);
}

function toCommentOutput(
  ctx: ConfluenceContext,
  comment: ConfluenceComment
): JsonObject {
  const authorId = comment.version.authorId ?? null;
  const own = ctx.connection.account?.externalAccountId ?? null;
  return {
    id: comment.id,
    authorId,
    mine: own !== null && authorId === own,
    createdAt: comment.version.createdAt ?? null,
    body: readBody(
      comment.body?.storage?.value,
      ConfluenceBodyFormat.Markdown,
      COMMENT_BODY_MAX
    ).body,
  };
}

function searchSpaceKeys(
  spaces: AllowedSpaces,
  space: string | null
): Result<string[], OperationFailure> {
  if (!space) {
    return Result.ok([...spaces.byId.values()].map((entry) => entry.key));
  }
  const found = findSpaceByKey(spaces, space);
  return found
    ? Result.ok([found.key])
    : Result.err({
        error: `Not allowed: space ${space} is not one of the project connection's spaces (${spaces.keys.join(", ")}).`,
        retryable: false,
      });
}

function cqlString(value: string): string {
  return `"${value.replaceAll(CQL_SPECIAL_RE, String.raw`\$&`)}"`;
}
