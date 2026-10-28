import {
  type CreatedPullRequest,
  HttpMethod,
  type IntegrationRepositoriesDefinition,
  type PullRequestRequest,
  type RepositoryInfo,
  type RepositoryOperationResult,
} from "../../types";
import {
  ADO_API_VERSION,
  type AdoContext,
  AdoErrorKind,
  adoRequest,
} from "./client";
import { adoPullRequests } from "./pull-requests";
import {
  operationError,
  operationOk,
  pullRequestsPath,
  repositoryErrorMessage,
} from "./repository-operations";
import {
  type AdoConnectionConfig,
  type AdoGitRepository,
  type AdoSecrets,
  adoGitRepositoryListSchema,
  adoGitRepositorySchema,
  adoPullRequestListSchema,
  adoPullRequestSchema,
  organizationNameFromUrl,
  parseUrl,
} from "./schemas";

/**
 * Azure Repos through the connection's PAT: list and read Git repositories of
 * the organization, issue the PAT as the git credential (Azure DevOps accepts
 * any user name with a PAT as the password) and open pull requests. Needs the
 * Code (Read & write) scope on the token.
 */

const REFS_HEADS = "refs/heads/";
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Any non-empty user name works with a PAT. */
const GIT_USERNAME = "agentflow";

export const adoRepositories: IntegrationRepositoriesDefinition<
  AdoConnectionConfig,
  AdoSecrets
> = {
  async list(ctx, options) {
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: "_apis/git/repositories",
        query: { "api-version": ADO_API_VERSION },
      },
      adoGitRepositoryListSchema
    );
    if (!result.ok) {
      throw new Error(repositoryErrorMessage(result.error));
    }
    const query = options.query?.toLowerCase() ?? null;
    return result.value.value
      .map((raw) => adoGitRepositorySchema.safeParse(raw))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((repository) => !repository.isDisabled)
      .map((repository) => toRepositoryInfo(ctx, repository))
      .filter((info): info is RepositoryInfo => info !== null)
      .filter((info) => !query || info.fullName.toLowerCase().includes(query))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .slice(0, options.limit);
  },

  async get(ctx, externalId) {
    if (!GUID_RE.test(externalId)) {
      return null;
    }
    const result = await adoRequest(
      ctx,
      {
        method: HttpMethod.Get,
        path: `_apis/git/repositories/${externalId}`,
        query: { "api-version": ADO_API_VERSION },
      },
      adoGitRepositorySchema
    );
    if (!result.ok) {
      if (result.error.kind === AdoErrorKind.NotFound) {
        return null;
      }
      throw new Error(repositoryErrorMessage(result.error));
    }
    if (result.value.isDisabled) {
      return null;
    }
    return toRepositoryInfo(ctx, result.value);
  },

  gitCredential(ctx) {
    return Promise.resolve({
      username: GIT_USERNAME,
      password: ctx.connection.secrets.pat,
      expiresAt: null,
    });
  },

  pullRequests: adoPullRequests,

  async createPullRequest(ctx, request) {
    const existing = await findActivePullRequest(ctx, request);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value !== null) {
      return operationOk(
        toCreatedPullRequest(request.repository, existing.value, true)
      );
    }
    const created = await adoRequest(
      ctx,
      {
        method: HttpMethod.Post,
        path: pullRequestsPath(request.repository),
        query: { "api-version": ADO_API_VERSION },
        body: {
          sourceRefName: `${REFS_HEADS}${request.sourceBranch}`,
          targetRefName: `${REFS_HEADS}${request.targetBranch}`,
          title: request.title,
          description: request.description,
          isDraft: request.draft,
        },
      },
      adoPullRequestSchema
    );
    if (!created.ok) {
      return operationError(created.error);
    }
    return operationOk(
      toCreatedPullRequest(
        request.repository,
        created.value.pullRequestId,
        false
      )
    );
  },
};

/** Organization / project / repository, e.g. "contoso/Shop/web". */
function toRepositoryInfo(
  ctx: AdoContext,
  repository: AdoGitRepository
): RepositoryInfo | null {
  const organizationUrl = ctx.connection.config.organizationUrl;
  const webUrl = repository.webUrl ?? null;
  const cloneUrl = toCloneUrl(repository.remoteUrl ?? webUrl, organizationUrl);
  if (!(webUrl && cloneUrl)) {
    return null;
  }
  const namespace = `${organizationNameFromUrl(organizationUrl)}/${repository.project.name}`;
  return {
    externalId: repository.id,
    fullName: `${namespace}/${repository.name}`,
    name: repository.name,
    namespace,
    defaultBranch: stripHeads(repository.defaultBranch),
    webUrl,
    isPrivate: repository.project.visibility !== "public",
    cloneUrl,
  };
}

/**
 * HTTPS clone URL without the user name ADO embeds ("contoso@dev.azure.com"):
 * the runner's credential helper supplies the user and the token. Plain HTTP
 * is accepted only for a local (test) organization URL.
 */
function toCloneUrl(
  remoteUrl: string | null,
  organizationUrl: string
): string | null {
  const url = remoteUrl ? parseUrl(remoteUrl) : null;
  if (!url) {
    return null;
  }
  const allowHttp = organizationUrl.startsWith("http:");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return null;
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

async function findActivePullRequest(
  ctx: AdoContext,
  request: PullRequestRequest
): Promise<RepositoryOperationResult<number | null>> {
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: pullRequestsPath(request.repository),
      query: {
        "searchCriteria.sourceRefName": `${REFS_HEADS}${request.sourceBranch}`,
        "searchCriteria.targetRefName": `${REFS_HEADS}${request.targetBranch}`,
        "searchCriteria.status": "active",
        $top: 1,
        "api-version": ADO_API_VERSION,
      },
    },
    adoPullRequestListSchema
  );
  if (!result.ok) {
    return operationError(result.error);
  }
  return operationOk(result.value.value[0]?.pullRequestId ?? null);
}

function toCreatedPullRequest(
  repository: RepositoryInfo,
  pullRequestId: number,
  existing: boolean
): CreatedPullRequest {
  return {
    url: `${repository.webUrl}/pullrequest/${pullRequestId}`,
    number: pullRequestId,
    externalId: String(pullRequestId),
    existing,
  };
}

function stripHeads(ref: string | null | undefined): string | null {
  if (!ref) {
    return null;
  }
  return ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
}
