import {
  type CreatedPullRequest,
  HttpMethod,
  type IntegrationRepositoriesDefinition,
  type PullRequestRequest,
  type RepositoryInfo,
  type RepositoryOperationResult,
} from "../../types";
import {
  type GitHubContext,
  type GitHubError,
  GitHubErrorKind,
  githubRequest,
  pathSegment,
} from "./client";
import {
  type GitHubConnectionConfig,
  type GitHubPullRequest,
  type GitHubRepository,
  type GitHubSecrets,
  githubPullRequestListSchema,
  githubPullRequestSchema,
  githubRepositoryPageSchema,
  githubRepositorySchema,
} from "./schemas";

/**
 * Repositories the connection's token can access: list and read them, issue
 * the token as the git credential and open pull requests. Archived
 * repositories are left out (nothing can be pushed to them).
 */

const PAGE_SIZE = 100;
/** Bounds a listing at 1000 repositories (10 requests). */
const MAX_PAGES = 10;
const REPOSITORY_ID_RE = /^\d{1,15}$/;
/** User name GitHub expects with a token over HTTPS. */
const GIT_USERNAME = "x-access-token";

export const githubRepositories: IntegrationRepositoriesDefinition<
  GitHubConnectionConfig,
  GitHubSecrets
> = {
  async list(ctx, options) {
    const query = options.query?.toLowerCase() ?? null;
    const found: RepositoryInfo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await githubRequest(
        ctx,
        {
          method: HttpMethod.Get,
          path: "/user/repos",
          query: {
            per_page: PAGE_SIZE,
            page,
            sort: "full_name",
            direction: "asc",
          },
        },
        githubRepositoryPageSchema
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      found.push(...matchingRepositories(result.value, query));
      if (found.length >= options.limit || result.value.length < PAGE_SIZE) {
        break;
      }
    }
    return found.slice(0, options.limit);
  },

  async get(ctx, externalId) {
    if (!REPOSITORY_ID_RE.test(externalId)) {
      return null;
    }
    const result = await githubRequest(
      ctx,
      { method: HttpMethod.Get, path: `/repositories/${externalId}` },
      githubRepositorySchema
    );
    if (!result.ok) {
      if (result.error.kind === GitHubErrorKind.NotFound) {
        return null;
      }
      throw new Error(result.error.message);
    }
    return isUsable(result.value) ? toRepositoryInfo(result.value) : null;
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
    const created = await githubRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: `${repositoryPath(request.repository)}/pulls`,
        body: {
          title: request.title,
          body: request.description,
          head: request.sourceBranch,
          base: request.targetBranch,
          draft: request.draft,
        },
      },
      githubPullRequestSchema
    );
    if (created.ok) {
      return operationOk(toCreatedPullRequest(created.value, false));
    }
    // A concurrent attempt may have opened it in the meantime (422).
    if (created.error.kind === GitHubErrorKind.Validation) {
      const raced = await findOpenPullRequest(ctx, request);
      if (raced.ok && raced.value) {
        return operationOk(toCreatedPullRequest(raced.value, true));
      }
    }
    return operationError(created.error);
  },
};

function matchingRepositories(
  page: unknown[],
  query: string | null
): RepositoryInfo[] {
  return page
    .map((raw) => githubRepositorySchema.safeParse(raw))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter(isUsable)
    .filter(
      (repository) =>
        !query || repository.full_name.toLowerCase().includes(query)
    )
    .map(toRepositoryInfo);
}

function isUsable(repository: GitHubRepository): boolean {
  return !(repository.archived || repository.disabled);
}

function toRepositoryInfo(repository: GitHubRepository): RepositoryInfo {
  return {
    externalId: String(repository.id),
    fullName: repository.full_name,
    name: repository.name,
    namespace: repository.owner.login,
    defaultBranch: repository.default_branch ?? null,
    webUrl: repository.html_url,
    isPrivate: repository.private,
    cloneUrl: repository.clone_url,
  };
}

async function findOpenPullRequest(
  ctx: GitHubContext,
  request: PullRequestRequest
): Promise<RepositoryOperationResult<GitHubPullRequest | null>> {
  const result = await githubRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `${repositoryPath(request.repository)}/pulls`,
      query: {
        state: "open",
        head: `${request.repository.namespace}:${request.sourceBranch}`,
        base: request.targetBranch,
        per_page: 1,
      },
    },
    githubPullRequestListSchema
  );
  if (!result.ok) {
    return operationError(result.error);
  }
  return operationOk(result.value[0] ?? null);
}

function repositoryPath(repository: RepositoryInfo): string {
  return `/repos/${pathSegment(repository.namespace)}/${pathSegment(repository.name)}`;
}

function toCreatedPullRequest(
  pullRequest: GitHubPullRequest,
  existing: boolean
): CreatedPullRequest {
  return {
    url: pullRequest.html_url,
    number: pullRequest.number,
    externalId: String(pullRequest.id),
    existing,
  };
}

function operationOk<T>(value: T): RepositoryOperationResult<T> {
  return { ok: true, value };
}

function operationError<T>(error: GitHubError): RepositoryOperationResult<T> {
  return { ok: false, error: error.message, retryable: error.retryable };
}
