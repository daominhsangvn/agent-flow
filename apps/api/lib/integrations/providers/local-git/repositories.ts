import {
  type CreatedPullRequest,
  type CreateRepositoryRequest,
  HttpMethod,
  type IntegrationRepositoriesDefinition,
  type PullRequestRequest,
  type RepositoryInfo,
  type RepositoryOperationResult,
} from "../../types";
import {
  type LocalGitContext,
  type LocalGitError,
  LocalGitErrorKind,
  localGitRequest,
  pathSegment,
} from "./client";
import {
  anyObjectSchema,
  type LocalGitConnectionConfig,
  type LocalGitPullRequest,
  type LocalGitRepository,
  type LocalGitSecrets,
  localGitPullRequestSchema,
  localGitRepositorySchema,
  localGitSearchSchema,
  localGitUserSchema,
} from "./schemas";

/**
 * Repositories of Local Git (Gitea) the connection's token can access: list,
 * read and create them, issue the token as the git credential and open pull
 * requests. A repository's external id is Gitea's numeric repository id,
 * which survives renames and transfers.
 */

const PAGE_SIZE = 50;
/** Bounds a listing at 5 pages. */
const MAX_PAGES = 5;
const EXTERNAL_ID_RE = /^[1-9]\d{0,18}$/;
/** Gitea takes any user name with a token as the password. */
const GIT_USERNAME = "agentflow";
/** Gitea marks a work-in-progress (draft) pull request by this title prefix. */
const DRAFT_TITLE_PREFIX = "WIP: ";
const OPEN_STATE = "open";

export const localGitRepositories: IntegrationRepositoriesDefinition<
  LocalGitConnectionConfig,
  LocalGitSecrets
> = {
  async list(ctx, options) {
    const ownerId = await resolveOwnerId(ctx);
    const query = options.query?.trim() || undefined;
    const found: RepositoryInfo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await localGitRequest(
        ctx,
        {
          method: HttpMethod.Get,
          path: "/repos/search",
          query: {
            q: query,
            uid: ownerId ?? undefined,
            exclusive: ownerId === null ? undefined : true,
            sort: "alpha",
            order: "asc",
            limit: PAGE_SIZE,
            page,
          },
        },
        localGitSearchSchema
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      for (const raw of result.value.data) {
        const parsed = localGitRepositorySchema.safeParse(raw);
        if (parsed.success) {
          found.push(toRepositoryInfo(ctx, parsed.data));
        }
      }
      if (
        result.value.data.length < PAGE_SIZE ||
        found.length >= options.limit
      ) {
        break;
      }
    }
    return found.slice(0, options.limit);
  },

  async get(ctx, externalId) {
    if (!EXTERNAL_ID_RE.test(externalId)) {
      return null;
    }
    const result = await localGitRequest(
      ctx,
      { method: HttpMethod.Get, path: `/repositories/${externalId}` },
      localGitRepositorySchema
    );
    if (!result.ok) {
      if (result.error.kind === LocalGitErrorKind.NotFound) {
        return null;
      }
      throw new Error(result.error.message);
    }
    return toRepositoryInfo(ctx, result.value);
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
    const created = await localGitRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: `${repositoryPath(request.repository)}/pulls`,
        body: {
          head: request.sourceBranch,
          base: request.targetBranch,
          title: request.draft
            ? `${DRAFT_TITLE_PREFIX}${request.title}`
            : request.title,
          body: request.description,
        },
      },
      localGitPullRequestSchema
    );
    if (created.ok) {
      return operationOk(toCreatedPullRequest(created.value, false));
    }
    // A concurrent attempt may have opened it in the meantime.
    if (created.error.kind === LocalGitErrorKind.Conflict) {
      const raced = await findOpenPullRequest(ctx, request);
      if (raced.ok && raced.value) {
        return operationOk(toCreatedPullRequest(raced.value, true));
      }
    }
    return operationError(created.error);
  },

  async create(ctx, request) {
    const target = await creationPath(ctx);
    if (!target.ok) {
      return target;
    }
    const created = await localGitRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: target.value,
        body: {
          name: request.name,
          description: request.description,
          private: request.isPrivate,
          auto_init: true,
          default_branch: "main",
          readme: "Default",
        },
      },
      localGitRepositorySchema
    );
    if (created.ok) {
      return operationOk(toRepositoryInfo(ctx, created.value));
    }
    if (created.error.kind === LocalGitErrorKind.Conflict) {
      return {
        ok: false,
        error: alreadyExistsMessage(ctx, request),
        retryable: false,
      };
    }
    return operationError(created.error);
  },
};

/** Id of the configured owner (user or organization); null when none is set. */
async function resolveOwnerId(ctx: LocalGitContext): Promise<number | null> {
  const owner = ctx.connection.config.owner.trim();
  if (!owner) {
    return null;
  }
  const result = await localGitRequest(
    ctx,
    { method: HttpMethod.Get, path: `/users/${pathSegment(owner)}` },
    localGitUserSchema
  );
  if (!result.ok) {
    throw new Error(
      result.error.kind === LocalGitErrorKind.NotFound
        ? `No user or organization "${owner}" on Local Git`
        : result.error.message
    );
  }
  return result.value.id;
}

/**
 * Where a new repository goes: the owner organization, or the token's own
 * account when no owner is set or the owner is that account.
 */
async function creationPath(
  ctx: LocalGitContext
): Promise<RepositoryOperationResult<string>> {
  const owner = ctx.connection.config.owner.trim();
  if (!owner) {
    return operationOk("/user/repos");
  }
  const organization = await localGitRequest(
    ctx,
    { method: HttpMethod.Get, path: `/orgs/${pathSegment(owner)}` },
    anyObjectSchema
  );
  if (organization.ok) {
    return operationOk(`/orgs/${pathSegment(owner)}/repos`);
  }
  if (organization.error.kind !== LocalGitErrorKind.NotFound) {
    return operationError(organization.error);
  }
  const user = await localGitRequest(
    ctx,
    { method: HttpMethod.Get, path: "/user" },
    localGitUserSchema
  );
  if (!user.ok) {
    return operationError(user.error);
  }
  if (user.value.login.toLowerCase() === owner.toLowerCase()) {
    return operationOk("/user/repos");
  }
  return {
    ok: false,
    error: `New repositories go to an organization or to the token's own account, and "${owner}" is another user. Change the connection's owner.`,
    retryable: false,
  };
}

function alreadyExistsMessage(
  ctx: LocalGitContext,
  request: CreateRepositoryRequest
): string {
  const owner = ctx.connection.config.owner.trim();
  return owner
    ? `A repository named "${request.name}" already exists in ${owner}`
    : `A repository named "${request.name}" already exists`;
}

function toRepositoryInfo(
  ctx: LocalGitContext,
  repository: LocalGitRepository
): RepositoryInfo {
  return {
    externalId: String(repository.id),
    fullName: repository.full_name,
    name: repository.name,
    namespace: repository.owner.login,
    defaultBranch: repository.empty
      ? null
      : repository.default_branch?.trim() || null,
    webUrl: repository.html_url,
    isPrivate: repository.private ?? true,
    cloneUrl: runnerCloneUrl(ctx.connection.config, repository.clone_url),
  };
}

/**
 * Gitea builds clone links from its own public URL; runners that reach it
 * at another address (a container on the same machine, another computer)
 * get the runner URL's scheme and host instead.
 */
function runnerCloneUrl(
  config: LocalGitConnectionConfig,
  cloneUrl: string
): string {
  if (!config.runnerUrl) {
    return cloneUrl;
  }
  try {
    const url = new URL(cloneUrl);
    const runner = new URL(config.runnerUrl);
    url.protocol = runner.protocol;
    url.host = runner.host;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

async function findOpenPullRequest(
  ctx: LocalGitContext,
  request: PullRequestRequest
): Promise<RepositoryOperationResult<LocalGitPullRequest | null>> {
  const result = await localGitRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: `${repositoryPath(request.repository)}/pulls/${pathSegment(request.targetBranch)}/${pathSegment(request.sourceBranch)}`,
    },
    localGitPullRequestSchema
  );
  if (result.ok) {
    return operationOk(result.value.state === OPEN_STATE ? result.value : null);
  }
  if (result.error.kind === LocalGitErrorKind.NotFound) {
    return operationOk(null);
  }
  return operationError(result.error);
}

function repositoryPath(repository: RepositoryInfo): string {
  return `/repos/${pathSegment(repository.namespace)}/${pathSegment(repository.name)}`;
}

function toCreatedPullRequest(
  pullRequest: LocalGitPullRequest,
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

function operationError<T>(error: LocalGitError): RepositoryOperationResult<T> {
  return { ok: false, error: error.message, retryable: error.retryable };
}
