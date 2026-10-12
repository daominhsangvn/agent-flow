import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { HttpMethod, type ValidateConnectionResult } from "../../types";
import {
  type BitbucketContext,
  BitbucketErrorKind,
  bitbucketRequest,
  pathSegment,
} from "./client";
import {
  API_URL_HINT,
  type BitbucketConnectionConfig,
  bitbucketPageSchema,
  bitbucketUserSchema,
  normalizeApiUrl,
} from "./schemas";

/**
 * Connection form and credential check. With an Atlassian API token the
 * token's account is the "bot": the agent team pushes and pull requests are
 * opened as this account. A workspace, project or repository access token
 * acts as its own bot user and needs the workspace set.
 */

export const BITBUCKET_REQUIRED_SCOPES =
  "read:user:bitbucket, read:workspace:bitbucket, read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket";

export const bitbucketConnectionFields: IntegrationFieldDescriptor[] = [
  {
    key: "token",
    label: "API token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description: `Atlassian API token with scopes of the bot account (Atlassian account settings → Security → Create API token with scopes, app: Bitbucket), with the scopes ${BITBUCKET_REQUIRED_SCOPES}. A workspace, project or repository access token with Repositories: Write and Pull requests: Write also works; then set the workspace.`,
  },
  {
    key: "workspace",
    label: "Workspace",
    kind: IntegrationFieldKind.Text,
    placeholder: "my-workspace",
    description:
      "Workspace ID, as in bitbucket.org/{workspace}. Leave empty to offer the repositories of every workspace the token's account belongs to. Required for access tokens.",
  },
];

/** Changing the workspace or API URL requires the token to be entered again. */
export const BITBUCKET_CREDENTIAL_ORIGIN_FIELDS: Array<
  keyof BitbucketConnectionConfig
> = ["apiUrl", "workspace"];

export async function validateBitbucketConnection(
  ctx: BitbucketContext
): Promise<ValidateConnectionResult<BitbucketConnectionConfig>> {
  const apiUrl = normalizeApiUrl(ctx.connection.config.apiUrl);
  if (!apiUrl) {
    return { ok: false, error: API_URL_HINT };
  }
  const workspace = ctx.connection.config.workspace.trim();
  const config: BitbucketConnectionConfig = { apiUrl, workspace };
  const checked: BitbucketContext = {
    ...ctx,
    connection: { ...ctx.connection, config },
  };
  if (workspace) {
    const repositories = await bitbucketRequest(
      checked,
      {
        method: HttpMethod.Get,
        path: `/repositories/${pathSegment(workspace)}`,
        query: { pagelen: 1 },
      },
      bitbucketPageSchema
    );
    if (!repositories.ok) {
      return { ok: false, error: repositories.error.message };
    }
  }
  const user = await bitbucketRequest(
    checked,
    { method: HttpMethod.Get, path: "/user" },
    bitbucketUserSchema
  );
  if (user.ok) {
    const login = user.value.nickname ?? user.value.username ?? null;
    return {
      ok: true,
      config,
      account: {
        externalAccountId: user.value.uuid,
        displayName: user.value.display_name?.trim() || login || "Bitbucket",
        aliases: login ? [login] : [],
        details: { workspace: workspace || null, apiUrl },
      },
    };
  }
  // An access token has no user; its workspace was checked above.
  const accessToken =
    workspace &&
    (user.error.kind === BitbucketErrorKind.Forbidden ||
      user.error.kind === BitbucketErrorKind.NotFound);
  if (!accessToken) {
    return {
      ok: false,
      error: workspace
        ? user.error.message
        : `${user.error.message}. For a workspace, project or repository access token, set the workspace`,
    };
  }
  return {
    ok: true,
    config,
    account: {
      externalAccountId: `workspace:${workspace}`,
      displayName: `${workspace} (access token)`,
      aliases: [],
      details: { workspace, apiUrl },
    },
  };
}
