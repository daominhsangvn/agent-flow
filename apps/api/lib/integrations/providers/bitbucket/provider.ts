import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { definePullRequestAction } from "../../pull-request-action";
import { defineIntegrationProvider } from "../../types";
import {
  BITBUCKET_CREDENTIAL_ORIGIN_FIELDS,
  bitbucketConnectionFields,
  validateBitbucketConnection,
} from "./connection";
import { BitbucketActionType } from "./constants";
import { bitbucketRepositories } from "./repositories";
import {
  type BitbucketConnectionConfig,
  type BitbucketSecrets,
  bitbucketConnectionConfigSchema,
  bitbucketSecretsSchema,
} from "./schemas";

/**
 * Bitbucket Cloud through an Atlassian API token with scopes (or a
 * workspace, project or repository access token): projects add repositories
 * from the connection, agents push to them with the token, and the "Create
 * pull request" action opens pull requests. No inbound side and no triggers
 * yet. Bitbucket Data Center has another API and is not supported.
 */
export const bitbucketProvider = defineIntegrationProvider<
  BitbucketConnectionConfig,
  BitbucketSecrets
>({
  key: IntegrationProviderKey.Bitbucket,
  displayName: "Bitbucket",
  description:
    "Work on Bitbucket Cloud repositories with an API token, and open pull requests from workflows.",
  docsUrl:
    "https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/",
  connection: {
    configSchema: bitbucketConnectionConfigSchema,
    secretsSchema: bitbucketSecretsSchema,
    fields: bitbucketConnectionFields,
    credentialOriginFields: BITBUCKET_CREDENTIAL_ORIGIN_FIELDS,
    validate: (ctx) => validateBitbucketConnection(ctx),
  },
  triggers: [],
  actions: [
    definePullRequestAction({
      key: BitbucketActionType.CreatePullRequest,
      providerName: "Bitbucket",
      repositories: bitbucketRepositories,
    }),
  ],
  repositories: bitbucketRepositories,
});
