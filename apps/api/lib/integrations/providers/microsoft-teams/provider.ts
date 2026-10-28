import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { defineIntegrationProvider } from "../../types";
import { verifyTeamsRequest } from "./bot-auth";
import {
  TEAMS_CONNECTION_FIELDS,
  type TeamsConnectionConfig,
  type TeamsConnectionSecrets,
  teamsConnectionConfigSchema,
  teamsConnectionSecretsSchema,
  validateTeamsConnection,
} from "./connection";
import { parseTeamsRequest } from "./inbound";
import { teamsPostMessageAction } from "./post-message-action";
import { teamsProjectDefinition } from "./project";
import {
  teamsEditOnItem,
  teamsReplyAction,
  teamsReplyOnItem,
} from "./reply-action";
import { buildTeamsSetupInstructions } from "./setup-instructions";
import { fetchTeamsThread } from "./source";
import { teamsBotMentionedTrigger } from "./trigger";

/**
 * Microsoft Teams, in two independent parts of one connection:
 *
 * - a Teams Workflows (Power Automate) webhook: microsoft_teams.post_message
 *   posts a card to its channel. Office 365 connector webhooks were retired
 *   in 2026 and are rejected;
 * - an Azure Bot: mentioning it in a channel post or reply starts a run
 *   (microsoft_teams.bot_mentioned, webhook delivery: the inbound URL is the
 *   bot's messaging endpoint). The run reads the thread through Microsoft
 *   Graph and carries out the message that mentioned the bot;
 *   microsoft_teams.reply answers in the thread.
 */
export const microsoftTeamsProvider = defineIntegrationProvider<
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>({
  key: IntegrationProviderKey.MicrosoftTeams,
  displayName: "Microsoft Teams",
  description:
    "Post workflow run updates to a Teams channel through a Workflows webhook, and start workflows by mentioning a bot in a channel: the run reads the thread, carries out the request and answers in the thread.",
  docsUrl:
    "https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc",
  connection: {
    configSchema: teamsConnectionConfigSchema,
    secretsSchema: teamsConnectionSecretsSchema,
    fields: TEAMS_CONNECTION_FIELDS,
    validate: validateTeamsConnection,
  },
  project: teamsProjectDefinition,
  inbound: {
    deliveryModes: [IntegrationDeliveryMode.Webhook],
    setupInstructions: buildTeamsSetupInstructions,
    verify: verifyTeamsRequest,
    parse: parseTeamsRequest,
  },
  source: {
    fetchItem: fetchTeamsThread,
  },
  triggers: [teamsBotMentionedTrigger],
  actions: [teamsPostMessageAction, teamsReplyAction],
  replyOnItem: teamsReplyOnItem,
  editOnItem: teamsEditOnItem,
});
