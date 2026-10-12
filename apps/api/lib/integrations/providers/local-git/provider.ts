import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { definePullRequestAction } from "../../pull-request-action";
import { defineIntegrationProvider } from "../../types";
import {
  LOCAL_GIT_CREDENTIAL_ORIGIN_FIELDS,
  localGitConnectionFields,
  validateLocalGitConnection,
} from "./connection";
import { LocalGitActionType } from "./constants";
import { localGitRepositories } from "./repositories";
import {
  type LocalGitConnectionConfig,
  type LocalGitSecrets,
  localGitConnectionConfigSchema,
  localGitSecretsSchema,
} from "./schemas";

/**
 * Local Git: git hosting on the team's own machine (the `local-git` service
 * of docker-compose.yml, Gitea) for projects without a remote. Projects add
 * or create repositories from the connection, agents push to them with its
 * token, and the "Create pull request" action opens pull requests that are
 * reviewed and merged in Local Git's web UI, where the code, commits and
 * branches can be browsed and downloaded. No inbound side and no triggers.
 */
export const localGitProvider = defineIntegrationProvider<
  LocalGitConnectionConfig,
  LocalGitSecrets
>({
  key: IntegrationProviderKey.LocalGit,
  displayName: "Local Git",
  description:
    "Git repositories hosted on your own machine, for projects without a remote: create them here, browse code, commits and branches in their web UI, and open pull requests from workflows.",
  docsUrl: "https://docs.gitea.com/usage/",
  connection: {
    configSchema: localGitConnectionConfigSchema,
    secretsSchema: localGitSecretsSchema,
    fields: localGitConnectionFields,
    credentialOriginFields: LOCAL_GIT_CREDENTIAL_ORIGIN_FIELDS,
    validate: (ctx) => validateLocalGitConnection(ctx),
  },
  triggers: [],
  actions: [
    definePullRequestAction({
      key: LocalGitActionType.CreatePullRequest,
      providerName: "Local Git",
      repositories: localGitRepositories,
    }),
  ],
  repositories: localGitRepositories,
});
