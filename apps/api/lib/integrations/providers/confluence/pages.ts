import { Result } from "@repo/api/src/types/result";
import { HttpMethod } from "../../types";
import {
  type ConfluenceContext,
  type ConfluenceError,
  ConfluenceErrorKind,
  confluenceRequest,
  confluenceWebUrl,
} from "./client";
import { confluenceProjectSettingsSchema } from "./project";
import {
  type ConfluenceConnectionConfig,
  type ConfluencePage,
  type ConfluenceSpace,
  confluenceListSchema,
  confluencePageSchema,
  confluenceSpaceSchema,
} from "./schemas";

/**
 * The space guard every Confluence operation goes through: a page (named by
 * a link or id that may come from untrusted ticket text) is used only when
 * it is in one of the project connection's spaces. Without a project
 * connection there are no spaces, so nothing is allowed.
 */

export type OperationFailure = { error: string; retryable: boolean };

/** The project connection's spaces, by space id. */
export type AllowedSpaces = {
  byId: ReadonlyMap<string, ConfluenceSpace>;
  keys: readonly string[];
  parentPageId: string | null;
};

export async function loadAllowedSpaces(
  ctx: ConfluenceContext
): Promise<Result<AllowedSpaces, OperationFailure>> {
  const settings = confluenceProjectSettingsSchema.safeParse(
    ctx.connection.projectSettings ?? {}
  );
  if (!settings.success) {
    return Result.err({
      error:
        "Confluence is used through a project connection, which names the spaces it may use; this one names none.",
      retryable: false,
    });
  }
  const { spaceKeys, parentPageId } = settings.data;
  const listed = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: "api/v2/spaces",
      query: { keys: spaceKeys.join(","), limit: SPACES_LIMIT },
    },
    confluenceListSchema
  );
  if (!listed.ok) {
    return Result.err(toFailure(listed.error));
  }
  const byId = new Map<string, ConfluenceSpace>();
  for (const value of listed.value.results) {
    const space = confluenceSpaceSchema.safeParse(value);
    if (space.success && hasKey(spaceKeys, space.data.key)) {
      byId.set(space.data.id, space.data);
    }
  }
  if (byId.size === 0) {
    return Result.err({
      error: `None of the project connection's spaces (${spaceKeys.join(", ")}) exists or is visible to the bot account.`,
      retryable: false,
    });
  }
  return Result.ok({
    byId,
    keys: spaceKeys,
    parentPageId: parentPageId ?? null,
  });
}

/**
 * A page id from what an agent or a workflow wrote: the id, or a link on the
 * connection's site (`/wiki/spaces/{key}/pages/{id}/…`,
 * `viewpage.action?pageId={id}`, a short `/wiki/x/{code}` link).
 */
export function parsePageReference(
  config: ConfluenceConnectionConfig,
  reference: string
): Result<string, string> {
  const value = reference.trim();
  if (PAGE_ID_RE.test(value)) {
    return Result.ok(value);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return Result.err(PAGE_REFERENCE_HINT);
  }
  if (url.origin !== new URL(config.siteUrl).origin) {
    return Result.err(
      `${url.origin} is not this connection's Confluence site (${config.siteUrl}).`
    );
  }
  const id =
    PAGE_PATH_RE.exec(url.pathname)?.[1] ??
    url.searchParams.get("pageId") ??
    decodeTinyLink(TINY_LINK_RE.exec(url.pathname)?.[1]);
  return id && PAGE_ID_RE.test(id)
    ? Result.ok(id)
    : Result.err(PAGE_REFERENCE_HINT);
}

/** The page, with its body in storage format, when it is in an allowed space. */
export async function loadAllowedPage(
  ctx: ConfluenceContext,
  spaces: AllowedSpaces,
  pageId: string
): Promise<Result<ConfluencePage, OperationFailure>> {
  const page = await confluenceRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `api/v2/pages/${encodeURIComponent(pageId)}`,
      query: { "body-format": "storage" },
    },
    confluencePageSchema
  );
  if (!page.ok) {
    return Result.err(toFailure(page.error));
  }
  const problem = spaceProblem(spaces, page.value.spaceId, `Page ${pageId}`);
  return problem ? Result.err(problem) : Result.ok(page.value);
}

/** Why a page or space id is refused, or null when it is an allowed space. */
export function spaceProblem(
  spaces: AllowedSpaces,
  spaceId: string,
  what: string
): OperationFailure | null {
  return spaces.byId.has(spaceId)
    ? null
    : {
        error: `Not allowed: ${what} is not in the project connection's spaces (${spaces.keys.join(", ")}).`,
        retryable: false,
      };
}

/** The allowed space with this key (any case), or null. */
export function findSpaceByKey(
  spaces: AllowedSpaces,
  key: string
): ConfluenceSpace | null {
  return (
    [...spaces.byId.values()].find(
      (space) => space.key.toUpperCase() === key.trim().toUpperCase()
    ) ?? null
  );
}

export function pageWebUrl(
  config: ConfluenceConnectionConfig,
  page: Pick<ConfluencePage, "id" | "_links">
): string {
  return (
    confluenceWebUrl(config, page._links?.webui) ??
    `${config.siteUrl}/wiki/pages/viewpage.action?pageId=${page.id}`
  );
}

export function toFailure(error: ConfluenceError): OperationFailure {
  return {
    error:
      error.kind === ConfluenceErrorKind.NotFound
        ? `${error.message}. It does not exist, or the bot account cannot see it.`
        : error.message,
    retryable: error.retryable,
  };
}

const SPACES_LIMIT = 50;
const PAGE_ID_RE = /^\d{1,20}$/;
const PAGE_PATH_RE = /\/wiki\/spaces\/[^/]+\/pages\/(?:edit-v2\/)?(\d+)/;
const TINY_LINK_RE = /\/wiki\/x\/([A-Za-z0-9_-]{1,16})$/;
const BYTE = 256n;
const PAGE_REFERENCE_HINT =
  'Name the page by its id (e.g. "123456") or its link (https://your-company.atlassian.net/wiki/spaces/ENG/pages/123456/Title).';

function hasKey(keys: readonly string[], key: string): boolean {
  return keys.some(
    (candidate) => candidate.toUpperCase() === key.toUpperCase()
  );
}

/**
 * A short link's code is the page id's little-endian bytes in base64 with
 * `-` for `/` and `_` for `+`, padding left out.
 */
function decodeTinyLink(code: string | undefined): string | null {
  if (!code) {
    return null;
  }
  const base64 = code.replaceAll("-", "/").replaceAll("_", "+");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "A");
  const bytes = Buffer.from(padded, "base64");
  let id = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    id = id * BYTE + BigInt(bytes[index] ?? 0);
  }
  return id > 0n ? id.toString() : null;
}
