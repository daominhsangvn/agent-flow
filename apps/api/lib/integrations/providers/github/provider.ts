import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { definePullRequestAction } from "../../pull-request-action";
import { defineIntegrationProvider } from "../../types";
import {
  GITHUB_CREDENTIAL_ORIGIN_FIELDS,
  githubConnectionFields,
  validateGitHubConnection,
} from "./connection";
import { GitHubActionType } from "./constants";
import { githubRepositories } from "./repositories";
import {
  type GitHubConnectionConfig,
  type GitHubSecrets,
  githubConnectionConfigSchema,
  githubSecretsSchema,
} from "./schemas";

/**
 * GitHub (github.com or Enterprise Server) through a fine-grained personal
 * access token: projects add repositories from the connection, agents push
 * to them with the token, and the "Create pull request" action opens pull
 * requests. No inbound side and no triggers yet.
 */
export const githubProvider = defineIntegrationProvider<
  GitHubConnectionConfig,
  GitHubSecrets
>({
  key: IntegrationProviderKey.GitHub,
  displayName: "GitHub",
  description:
    "Work on GitHub repositories with a fine-grained personal access token, and open pull requests from workflows.",
  docsUrl:
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  connection: {
    configSchema: githubConnectionConfigSchema,
    secretsSchema: githubSecretsSchema,
    fields: githubConnectionFields,
    credentialOriginFields: GITHUB_CREDENTIAL_ORIGIN_FIELDS,
    validate: (ctx) => validateGitHubConnection(ctx),
  },
  triggers: [],
  actions: [
    definePullRequestAction({
      key: GitHubActionType.CreatePullRequest,
      providerName: "GitHub",
      repositories: githubRepositories,
    }),
  ],
  repositories: githubRepositories,
});
