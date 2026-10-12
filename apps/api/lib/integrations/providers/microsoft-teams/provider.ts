import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { defineIntegrationProvider } from "../../types";
import {
  TEAMS_CONNECTION_FIELDS,
  type TeamsConnectionConfig,
  type TeamsConnectionSecrets,
  teamsConnectionConfigSchema,
  teamsConnectionSecretsSchema,
  validateTeamsConnection,
} from "./connection";
import { teamsPostMessageAction } from "./post-message-action";

/**
 * Microsoft Teams through a Teams Workflows (Power Automate) webhook. One
 * action (usable as a pre or post action); no inbound side, no source items,
 * no triggers. Office 365 connector webhooks were retired in 2026 and are
 * rejected.
 */
export const microsoftTeamsProvider = defineIntegrationProvider<
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>({
  key: IntegrationProviderKey.MicrosoftTeams,
  displayName: "Microsoft Teams",
  description:
    "Post workflow run updates to a Teams channel as Adaptive Cards through a Teams Workflows webhook.",
  docsUrl:
    "https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook",
  connection: {
    configSchema: teamsConnectionConfigSchema,
    secretsSchema: teamsConnectionSecretsSchema,
    fields: TEAMS_CONNECTION_FIELDS,
    validate: validateTeamsConnection,
  },
  triggers: [],
  actions: [teamsPostMessageAction],
});
