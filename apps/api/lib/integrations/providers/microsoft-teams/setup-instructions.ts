import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import type { InboundSetupContext } from "../../types";
import type { TeamsConnectionConfig } from "./connection";

/**
 * Markdown shown to the admin next to the inbound URL: how to create the
 * Azure Bot whose messaging endpoint is that URL, and the Teams app that
 * installs the bot in a team with permission to read its channel messages.
 * The inbound secret is not used: the Bot Framework signs its requests.
 */

const APP_ID_PLACEHOLDER = "<Bot App ID>";

export function buildTeamsSetupInstructions(
  context: InboundSetupContext<TeamsConnectionConfig>
): string {
  if (context.deliveryMode !== IntegrationDeliveryMode.Webhook) {
    return [
      "This connection does not receive mentions; workflows can use it to post to a channel (**Post to a Teams channel**) through the Workflows webhook.",
      "",
      "To let people start workflows by mentioning a bot in a channel, enter the bot fields and switch the delivery mode to **Webhook**.",
    ].join("\n");
  }
  const appId = context.connection.config.appId ?? APP_ID_PLACEHOLDER;
  return [
    "Teams sends the bot's messages to this URL (the Azure Bot's **messaging endpoint**):",
    "",
    `\`${context.inboundUrl}\``,
    "",
    "It must be a public **HTTPS** URL. Behind NAT, publish the API with a tunnel such as `cloudflared` and set `PUBLIC_WEBHOOK_BASE_URL` to the tunnel's address, so the URL above uses it. The Bot Framework signs every request; the inbound secret is not used.",
    ...missingBotNote(context.connection.config),
    "",
    "### 1. Azure Bot",
    "",
    "1. In the Azure portal create an **Azure Bot**, type of app **Single Tenant**, with a new app registration (the free F0 plan is enough).",
    "2. **Configuration**: set **Messaging endpoint** to the URL above. Copy the **Microsoft App ID** and the app's **tenant ID** into this connection.",
    "3. In the app registration open **Certificates & secrets**, create a client secret and paste it into this connection (it expires: renew it before then).",
    "4. **Channels**: add **Microsoft Teams**.",
    "",
    "### 2. Teams app",
    "",
    "Create an app package (a zip with `manifest.json` and two icons, `color.png` 192×192 and `outline.png` 32×32) and upload it in Teams (**Apps > Manage your apps > Upload an app**; your Teams admin may have to allow custom apps). The resource-specific permission lets the bot read the threads of the teams it is installed in, and nothing else:",
    "",
    "```json",
    manifestTemplate(appId),
    "```",
    "",
    "Add the app to each team whose channels should use it. Mentions in group chats and personal chats are ignored.",
    "",
    "### 3. Project and workflow",
    "",
    "1. Add this connection to a project and list the **channels** (links or ids) whose mentions start the project's workflows.",
    "2. In a workflow add the trigger **Bot mentioned in a channel** on that project connection.",
    "3. Answer in the thread with the action `microsoft_teams.reply` (e.g. `on: workflow.triggered` to say the bot is on it, `on: workflow.completed` with the result). Agents can answer too when the workflow grants `source: [comment]`.",
  ].join("\n");
}

function manifestTemplate(appId: string): string {
  const manifest = {
    $schema:
      "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: "1.0.0",
    id: appId,
    developer: {
      name: "Your company",
      websiteUrl: "https://example.com",
      privacyUrl: "https://example.com/privacy",
      termsOfUseUrl: "https://example.com/terms",
    },
    name: { short: "AgentFlow" },
    description: {
      short: "Mention AgentFlow to start a workflow",
      full: "Mention AgentFlow in a channel: it reads the thread and carries out the request.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#FFFFFF",
    bots: [
      {
        botId: appId,
        scopes: ["team"],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    validDomains: [],
    webApplicationInfo: { id: appId, resource: "https://AnyString" },
    authorization: {
      permissions: {
        resourceSpecific: [
          { name: "ChannelMessage.Read.Group", type: "Application" },
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

function missingBotNote(config: TeamsConnectionConfig): string[] {
  if (config.appId && config.tenantId) {
    return [];
  }
  return [
    "",
    "> The bot is not set yet: enter its App ID, tenant ID and client secret in this connection. Until then every request to this URL is refused.",
  ];
}
