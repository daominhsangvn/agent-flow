import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { HttpMethod, type ValidateConnectionResult } from "../../types";
import { type GitHubContext, githubRequest } from "./client";
import {
  API_URL_HINT,
  GITHUB_DEFAULT_API_URL,
  type GitHubConnectionConfig,
  githubUserSchema,
  normalizeApiUrl,
} from "./schemas";

/**
 * Connection form and credential check. The token owner is the "bot": the
 * agent team pushes and pull requests are opened as this account.
 */

export const githubConnectionFields: IntegrationFieldDescriptor[] = [
  {
    key: "token",
    label: "Personal access token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description:
      "Fine-grained personal access token of the bot account. Give it access to the repositories projects will use, with the Contents and Pull requests permissions set to Read and write (Metadata: Read is added automatically).",
  },
  {
    key: "apiUrl",
    label: "API URL",
    kind: IntegrationFieldKind.Url,
    placeholder: GITHUB_DEFAULT_API_URL,
    defaultValue: GITHUB_DEFAULT_API_URL,
    description:
      "Leave the default for github.com. For GitHub Enterprise Server use https://{host}/api/v3.",
  },
];

/** Changing the API URL requires the token to be entered again. */
export const GITHUB_CREDENTIAL_ORIGIN_FIELDS: Array<
  keyof GitHubConnectionConfig
> = ["apiUrl"];

export async function validateGitHubConnection(
  ctx: GitHubContext
): Promise<ValidateConnectionResult<GitHubConnectionConfig>> {
  const apiUrl = normalizeApiUrl(ctx.connection.config.apiUrl);
  if (!apiUrl) {
    return { ok: false, error: API_URL_HINT };
  }
  const config: GitHubConnectionConfig = { apiUrl };
  const user = await githubRequest(
    { ...ctx, connection: { ...ctx.connection, config } },
    { method: HttpMethod.Get, path: "/user" },
    githubUserSchema
  );
  if (!user.ok) {
    return { ok: false, error: user.error.message };
  }
  return {
    ok: true,
    config,
    account: {
      externalAccountId: String(user.value.id),
      displayName: user.value.name?.trim() || user.value.login,
      aliases: [user.value.login],
      details: { login: user.value.login, apiUrl },
    },
  };
}
