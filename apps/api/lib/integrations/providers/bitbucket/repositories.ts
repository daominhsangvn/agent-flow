import type { Result } from "@repo/api/src/types/result";
import {
  type CreatedPullRequest,
  HttpMethod,
  type IntegrationRepositoriesDefinition,
  type PullRequestRequest,
  type RepositoryInfo,
  type RepositoryOperationResult,
} from "../../types";
import {
  type BitbucketContext,
  type BitbucketError,
  BitbucketErrorKind,
  bbqlString,
  bitbucketRequest,
  pathSegment,
} from "./client";
import {
  type BitbucketConnectionConfig,
  type BitbucketPage,
  type BitbucketPullRequest,
  type BitbucketRepository,
  type BitbucketSecrets,
  bitbucketPageSchema,
  bitbucketPullRequestSchema,
  bitbucketRepositorySchema,
  bitbucketWorkspaceAccessSchema,
} from "./schemas";

/**
 * Repositories the connection's token can access: list and read them, issue
 * the token as the git credential and open pull requests.
 *
 * Listing goes through the workspaces: the connection's workspace, else
 * every workspace of the token's account (GET /user/workspaces; Bitbucket
 * removed the cross-workspace repository listing). A repository's external
 * id is `{workspace uuid}/{repository uuid}`, which survives renames.
 */

const PAGE_SIZE = 100;
/** Bounds a listing at 15 requests (workspaces and repository pages). */
const MAX_REQUESTS = 15;
const UUID = String.raw`\{[0-9a-fA-F-]{36}\}`;
const EXTERNAL_ID_RE = new RegExp(`^(${UUID})/(${UUID})$`);
/** User name Bitbucket accepts with any token over HTTPS. */
const GIT_USERNAME = "x-token-auth";

export const bitbucketRepositories: IntegrationRepositoriesDefinition<
  BitbucketConnectionConfig,
  BitbucketSecrets
> = {
  async list(ctx, options) {
    const budget = { requests: MAX_REQUESTS };
    const configured = ctx.connection.config.workspace.trim();
    const workspaces = configured
      ? [configured]
      : await listWorkspaces(ctx, budget);
    const query = options.query?.trim() || null;
    const found: RepositoryInfo[] = [];
    for (const workspace of workspaces) {
      if (found.length >= options.limit || budget.requests <= 0) {
        break;
      }
      found.push(
        ...(await listWorkspaceRepositories(ctx, budget, {
          workspace,
          query,
          // Without a configured workspace, only repositories the account
          // is a member of (not the public ones of its workspaces).
          memberOnly: !configured,
          limit: options.limit - found.length,
        }))
      );
    }
    return found.slice(0, options.limit);
  },

  async get(ctx, externalId) {
    const match = EXTERNAL_ID_RE.exec(externalId);
    if (!match) {
      return null;
    }
    const [, workspaceUuid, repositoryUuid] = match;
    const result = await bitbucketRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: `/repositories/${pathSegment(workspaceUuid)}/${pathSegment(repositoryUuid)}`,
      },
      bitbucketRepositorySchema
    );
    if (!result.ok) {
      if (result.error.kind === BitbucketErrorKind.NotFound) {
        return null;
      }
      throw new Error(result.error.message);
    }
    return toRepositoryInfo(result.value);
  },

  gitCredential(ctx) {
    return Promise.resolve({
      username: GIT_USERNAME,
      password: ctx.connection.secrets.token,
      expiresAt: null,
    });
  },

  async createPullRequest(ctx, request) {
    const existing = await findOpenPullRequest(ctx, request);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value) {
      return operationOk(toCreatedPullRequest(existing.value, true));
    }
    const created = await bitbucketRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: `${repositoryPath(request.repository)}/pullrequests`,
        body: {
          title: request.title,
          description: request.description,
          source: { branch: { name: request.sourceBranch } },
          destination: { branch: { name: request.targetBranch } },
          close_source_branch: false,
          ...(request.draft ? { draft: true } : {}),
        },
      },
      bitbucketPullRequestSchema
    );
    if (created.ok) {
      return operationOk(toCreatedPullRequest(created.value, false));
    }
    // A concurrent attempt may have opened it in the meantime (400).
    if (created.error.kind === BitbucketErrorKind.Validation) {
      const raced = await findOpenPullRequest(ctx, request);
      if (raced.ok && raced.value) {
        return operationOk(toCreatedPullRequest(raced.value, true));
      }
    }
    return operationError(created.error);
  },
};

type RequestBudget = { requests: number };

async function listWorkspaces(
  ctx: BitbucketContext,
  budget: RequestBudget
): Promise<string[]> {
  const workspaces: string[] = [];
  let next: string | null = "/user/workspaces";
  let query: Record<string, number> | undefined = { pagelen: PAGE_SIZE };
  while (next && budget.requests > 0) {
    budget.requests -= 1;
    const page: Result<BitbucketPage, BitbucketError> = await bitbucketRequest(
      ctx,
      { method: HttpMethod.Get, path: next, query },
      bitbucketPageSchema
    );
    if (!page.ok) {
      throw new Error(page.error.message);
    }
    for (const raw of page.value.values) {
      const parsed = bitbucketWorkspaceAccessSchema.safeParse(raw);
      if (parsed.success) {
        workspaces.push(parsed.data.workspace.slug);
      }
    }
    next = page.value.next ?? null;
    query = undefined;
  }
  return workspaces.sort((a, b) => a.localeCompare(b));
}

async function listWorkspaceRepositories(
  ctx: BitbucketContext,
  budget: RequestBudget,
  options: {
    workspace: string;
    query: string | null;
    memberOnly: boolean;
    limit: number;
  }
): Promise<RepositoryInfo[]> {
  const found: RepositoryInfo[] = [];
  let next: string | null = `/repositories/${pathSegment(options.workspace)}`;
  let query: Record<string, string | number | undefined> | undefined = {
    pagelen: PAGE_SIZE,
    sort: "full_name",
    role: options.memberOnly ? "member" : undefined,
    q: options.query ? `full_name ~ ${bbqlString(options.query)}` : undefined,
  };
  while (next && found.length < options.limit && budget.requests > 0) {
    budget.requests -= 1;
    const page: Result<BitbucketPage, BitbucketError> = await bitbucketRequest(
      ctx,
      { method: HttpMethod.Get, path: next, query },
      bitbucketPageSchema
    );
    if (!page.ok) {
      throw new Error(page.error.message);
    }
    for (const raw of page.value.values) {
      const parsed = bitbucketRepositorySchema.safeParse(raw);
      if (parsed.success) {
        found.push(toRepositoryInfo(parsed.data));
      }
    }
    next = page.value.next ?? null;
    query = undefined;
  }
  return found;
}

function toRepositoryInfo(repository: BitbucketRepository): RepositoryInfo {
  const webUrl = repository.links.html.href;
  return {
    externalId: `${repository.workspace.uuid}/${repository.uuid}`,
    fullName: repository.full_name,
    name: repository.slug,
    namespace: repository.workspace.slug,
    defaultBranch: repository.mainbranch?.name ?? null,
    webUrl,
    isPrivate: repository.is_private ?? true,
    cloneUrl: httpsCloneUrl(repository) ?? `${webUrl}.git`,
  };
}

/**
 * The HTTPS clone link without the user name Bitbucket puts in it
 * (`https://{user}@bitbucket.org/...`): the loop's credential helper supplies
 * the user and token.
 */
function httpsCloneUrl(repository: BitbucketRepository): string | null {
  const link = repository.links.clone?.find((entry) => entry.name === "https");
  if (!link) {
    return null;
  }
  try {
    const url = new URL(link.href);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function findOpenPullRequest(
  ctx: BitbucketContext,
  request: PullRequestRequest
): Promise<RepositoryOperationResult<BitbucketPullRequest | null>> {
  const result = await bitbucketRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `${repositoryPath(request.repository)}/pullrequests`,
      query: {
        state: "OPEN",
        q: `source.branch.name = ${bbqlString(request.sourceBranch)} AND destination.branch.name = ${bbqlString(request.targetBranch)}`,
        pagelen: 1,
      },
    },
    bitbucketPageSchema
  );
  if (!result.ok) {
    return operationError(result.error);
  }
  const first = bitbucketPullRequestSchema.safeParse(result.value.values[0]);
  return operationOk(first.success ? first.data : null);
}

function repositoryPath(repository: RepositoryInfo): string {
  return `/repositories/${pathSegment(repository.namespace)}/${pathSegment(repository.name)}`;
}

function toCreatedPullRequest(
  pullRequest: BitbucketPullRequest,
  existing: boolean
): CreatedPullRequest {
  return {
    url: pullRequest.links.html.href,
    number: pullRequest.id,
    externalId: String(pullRequest.id),
    existing,
  };
}

function operationOk<T>(value: T): RepositoryOperationResult<T> {
  return { ok: true, value };
}

function operationError<T>(
  error: BitbucketError
): RepositoryOperationResult<T> {
  return { ok: false, error: error.message, retryable: error.retryable };
}
