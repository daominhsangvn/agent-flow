import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import { INBOUND_TOKEN_HEADER_DISPLAY } from "../../inbound-auth";
import type { InboundSetupContext, IntegrationAccount } from "../../types";
import { JiraDeployment } from "./constants";
import { jiraBotJqlIdentifier } from "./identity";
import type { JiraConnectionConfig } from "./schemas";

/**
 * Markdown shown to the admin next to the inbound URL and secret. Webhook
 * mode offers two setups: a Jira admin webhook (HMAC-signed with the secret)
 * or a Jira Automation rule (static token header). Poll mode needs no setup
 * in Jira but only detects assignments.
 */

export function buildJiraSetupInstructions(
  context: InboundSetupContext<JiraConnectionConfig>
): string {
  if (context.deliveryMode === IntegrationDeliveryMode.Poll) {
    return pollInstructions(context);
  }
  if (context.deliveryMode === IntegrationDeliveryMode.Webhook) {
    return webhookInstructions(context);
  }
  return [
    "This connection does not receive events from Jira; workflows can use it for actions only (comment on or transition the source issue, as pre or post actions).",
    "",
    "To start workflows from Jira, switch the delivery mode to **Webhook** (Jira calls AgentFlow) or **Poll** (AgentFlow asks Jira periodically).",
  ].join("\n");
}

function webhookInstructions(
  context: InboundSetupContext<JiraConnectionConfig>
): string {
  const bot = describeBot(context.connection.account);
  const isCloud = context.connection.config.deployment === JiraDeployment.Cloud;
  return [
    "Jira sends issue events to this URL:",
    "",
    `\`${context.inboundUrl}\``,
    "",
    isCloud
      ? "Jira Cloud only calls public **HTTPS** URLs with a publicly trusted certificate, on port **443** (or another allowed port such as 8443). A localhost, private or plain-HTTP address will not work."
      : "Jira must be able to reach this URL from its own network (Jira Data Center calls it from the Jira server).",
    ...missingBotNote(context.connection.account),
    "",
    "### Option 1: Jira admin webhook (recommended)",
    "",
    "Requires the Jira administrator role. Jira signs every request with the secret.",
    "",
    "1. In Jira open **Settings (⚙) > System > WebHooks** and choose **Create a WebHook**.",
    `2. **URL**: \`${context.inboundUrl}\``,
    `3. **Secret**: \`${context.inboundSecret}\``,
    "4. **Events**: under *Issue* select **created** and **updated**. For **Bot mentioned** triggers also select *Comment* **created** and **updated**.",
    `5. **JQL filter**: \`assignee = "${bot.jql}"\` so only issues assigned to the bot account (${bot.label}) are sent. For **Issue labeled** or **Bot mentioned** triggers on issues that are not assigned to the bot, widen the filter (e.g. \`assignee = "${bot.jql}" OR labels = ai-ready\`) or leave it empty.`,
    "6. Leave **Exclude body** unchecked and save.",
    "",
    "### Option 2: Jira Automation rule",
    "",
    "Works without the Jira administrator role (project administrators can create rules). It covers **Issue assigned** triggers only.",
    "",
    "1. Open **Project settings > Automation** and create a rule.",
    "2. Trigger: **Work item assigned**.",
    `3. Condition: **Assignee** equals the bot account (${bot.label}).`,
    "4. Action: **Send web request**",
    `   - Web request URL: \`${context.inboundUrl}\``,
    "   - HTTP method: **POST**",
    "   - Web request body: **Work item data (Jira format)**",
    `   - Header \`${INBOUND_TOKEN_HEADER_DISPLAY}\` with the value \`${context.inboundSecret}\` (mark it **Hidden**).`,
    "5. Turn the rule on.",
    "",
    "### No public URL?",
    "",
    "If Jira cannot reach this server (for example it runs behind NAT without a tunnel or reverse proxy), switch this connection's delivery mode to **Poll**. AgentFlow then asks Jira for newly assigned issues on every poll interval; no Jira configuration is needed.",
  ].join("\n");
}

function pollInstructions(
  context: InboundSetupContext<JiraConnectionConfig>
): string {
  const bot = describeBot(context.connection.account);
  return [
    `AgentFlow polls Jira on every poll interval for issues assigned to the bot account (${bot.label}) that changed recently (JQL \`assignee = currentUser() AND updated >= …\`, signed in with the connection's credentials). No configuration is needed in Jira and this server does not need a public URL.`,
    ...missingBotNote(context.connection.account),
    "",
    "Polling detects **Issue assigned** triggers (an issue created with, or changed to, the bot as assignee). **Issue labeled** and **Bot mentioned** triggers need **Webhook** delivery: Jira search cannot tell when a label was added or who was mentioned.",
  ].join("\n");
}

function describeBot(account: IntegrationAccount | null): {
  jql: string;
  label: string;
} {
  if (!account) {
    return { jql: "<bot account id>", label: "the connection's account" };
  }
  const jql = jiraBotJqlIdentifier(account);
  return {
    jql,
    label: account.displayName ? `${account.displayName}, ${jql}` : jql,
  };
}

function missingBotNote(account: IntegrationAccount | null): string[] {
  if (account) {
    return [];
  }
  return [
    "",
    "> The bot account is not known yet. Test the connection so AgentFlow can look it up; until then events cannot be matched to the bot.",
  ];
}
