import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import {
  type IntegrationAccount,
  type ProviderContext,
  ValidateConnectionReason,
  type ValidateConnectionResult,
} from "../../types";
import { buildTeamsMessage, buildTestCardContent } from "./adaptive-card";
import { teamsBotId } from "./constants";
import {
  acquireEntraToken,
  BOT_FRAMEWORK_SCOPE,
  type BotCredentials,
  GRAPH_SCOPE,
} from "./entra-token";
import { describeTeamsFailure, postTeamsMessage } from "./teams-client";
import { checkTeamsWebhookUrl } from "./webhook-url";

/**
 * A Teams connection has two independent parts, at least one of them set:
 *
 * - a Workflows webhook URL (microsoft_teams.post_message). It is a secret:
 *   the URL itself authorizes posting (the "Anyone" trigger mode carries a
 *   SAS signature in the query string);
 * - a bot: the Entra app registration of an Azure Bot (App ID, tenant ID,
 *   client secret). Mentions of the bot in a channel start runs
 *   (microsoft_teams.bot_mentioned), runs read the thread through Microsoft
 *   Graph and answer in it (microsoft_teams.reply).
 */

const WEBHOOK_URL_MAX_LENGTH = 4096;
const CLIENT_SECRET_MAX_LENGTH = 1024;
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TEAMS_BOT_INCOMPLETE_ERROR =
  "Enter the bot's App ID, tenant ID and client secret together, or none of them.";
export const TEAMS_NOTHING_CONFIGURED_ERROR =
  "Enter a Workflows webhook URL (to post to a channel), the bot (to be mentioned in channels), or both.";

export const teamsConnectionConfigSchema = z.object({
  appId: optionalGuid(
    "The App ID is a GUID such as 00000000-0000-0000-0000-000000000000."
  ),
  tenantId: optionalGuid(
    "The tenant ID is a GUID such as 00000000-0000-0000-0000-000000000000."
  ),
});
export type TeamsConnectionConfig = z.infer<typeof teamsConnectionConfigSchema>;

export const teamsConnectionSecretsSchema = z.object({
  webhookUrl: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .max(WEBHOOK_URL_MAX_LENGTH)
      .superRefine((value, context) => {
        const checked = checkTeamsWebhookUrl(value);
        if (!checked.ok) {
          context.addIssue({ code: "custom", message: checked.error });
        }
      })
      .optional()
  ),
  clientSecret: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(CLIENT_SECRET_MAX_LENGTH).optional()
  ),
});
export type TeamsConnectionSecrets = z.infer<
  typeof teamsConnectionSecretsSchema
>;

export const TEAMS_CONNECTION_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "webhookUrl",
    label: "Workflows webhook URL",
    kind: IntegrationFieldKind.Secret,
    description:
      'To post to one channel ("Post to a Teams channel"). In the Teams channel open ••• > Workflows, pick the "Send webhook alerts to a channel" template (trigger "When a Teams webhook request is received") and copy the URL it shows. Office 365 connector URLs (*.webhook.office.com) were retired in 2026 and are not accepted. "Test" posts a test card to the channel.',
    placeholder:
      "https://….environment.api.powerplatform.com/powerautomate/automations/direct/workflows/…",
  },
  {
    key: "appId",
    label: "Bot App ID",
    kind: IntegrationFieldKind.Text,
    description:
      "To be mentioned in channels and answer in the thread. The Microsoft App ID of the Azure Bot (single tenant): Azure Bot > Configuration. Leave the three bot fields empty to only post through the webhook.",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    key: "tenantId",
    label: "Tenant ID",
    kind: IntegrationFieldKind.Text,
    description:
      "Directory (tenant) ID of the bot's app registration. Only mentions from this tenant are accepted.",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    key: "clientSecret",
    label: "Bot client secret",
    kind: IntegrationFieldKind.Secret,
    description:
      "A client secret of the bot's app registration (Certificates & secrets). Saving signs the bot in once to check it.",
  },
];

export type TeamsProviderContext = ProviderContext<
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>;

/**
 * "save" checks the webhook URL and signs the bot in (no side effects);
 * "test" also posts a test card through the webhook and checks that the bot
 * can get a Microsoft Graph token.
 */
export async function validateTeamsConnection(
  context: TeamsProviderContext,
  reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<TeamsConnectionConfig>> {
  const bot = readBotCredentials(context.connection);
  if (!bot.ok) {
    return { ok: false, error: bot.error };
  }
  const { webhookUrl } = context.connection.secrets;
  if (!(webhookUrl || bot.value)) {
    return { ok: false, error: TEAMS_NOTHING_CONFIGURED_ERROR };
  }
  if (webhookUrl) {
    const webhook = await checkWebhook(context, webhookUrl, reason);
    if (!webhook.ok) {
      return { ok: false, error: webhook.error };
    }
  }
  if (!bot.value) {
    return { ok: true, account: null };
  }
  const scopes =
    reason === ValidateConnectionReason.Test
      ? [BOT_FRAMEWORK_SCOPE, GRAPH_SCOPE]
      : [BOT_FRAMEWORK_SCOPE];
  for (const scope of scopes) {
    const token = await acquireEntraToken(
      context.http,
      bot.value,
      scope,
      context.now()
    );
    if (!token.ok) {
      return { ok: false, error: token.error.message };
    }
  }
  return { ok: true, account: botAccount(bot.value) };
}

/**
 * The bot's credentials; null when no bot is configured, an error when only
 * some of its fields are set.
 */
export function readBotCredentials(connection: {
  config: TeamsConnectionConfig;
  secrets: TeamsConnectionSecrets;
}): Result<BotCredentials | null, string> {
  const { appId, tenantId } = connection.config;
  const { clientSecret } = connection.secrets;
  if (appId && tenantId && clientSecret) {
    return Result.ok({ appId, tenantId, clientSecret });
  }
  if (appId || tenantId || clientSecret) {
    return Result.err(TEAMS_BOT_INCOMPLETE_ERROR);
  }
  return Result.ok(null);
}

async function checkWebhook(
  context: TeamsProviderContext,
  value: string,
  reason: ValidateConnectionReason
): Promise<Result<null, string>> {
  const webhookUrl = checkTeamsWebhookUrl(value);
  if (!webhookUrl.ok) {
    return webhookUrl;
  }
  if (reason === ValidateConnectionReason.Save) {
    return Result.ok(null);
  }
  const response = await postTeamsMessage(
    context.http,
    webhookUrl.value,
    buildTeamsMessage(buildTestCardContent(context.connection.name))
  );
  if (response.ok) {
    return Result.ok(null);
  }
  context.log.warn("Teams test message was not accepted", {
    connectionId: context.connection.id,
    status: response.status,
  });
  return Result.err(describeTeamsFailure(response));
}

function botAccount(bot: BotCredentials): IntegrationAccount {
  return {
    externalAccountId: teamsBotId(bot.appId),
    displayName: null,
    aliases: [bot.appId],
    details: { tenantId: bot.tenantId },
  };
}

function optionalGuid(message: string) {
  return z.preprocess(
    emptyToUndefined,
    z.string().trim().toLowerCase().regex(GUID_RE, message).optional()
  );
}

/** Form fields left empty arrive as "" (or whitespace): treated as not set. */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}
