import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import {
  type ProviderContext,
  ValidateConnectionReason,
  type ValidateConnectionResult,
} from "../../types";
import { buildTeamsMessage, buildTestCardContent } from "./adaptive-card";
import { describeTeamsFailure, postTeamsMessage } from "./teams-client";
import { checkTeamsWebhookUrl } from "./webhook-url";

/**
 * A Teams connection is only the Workflows webhook URL. It is a secret: the
 * URL itself authorizes posting (the "Anyone" trigger mode carries a SAS
 * signature in the query string).
 */

const WEBHOOK_URL_MAX_LENGTH = 4096;

export const teamsConnectionConfigSchema = z.object({});
export type TeamsConnectionConfig = z.infer<typeof teamsConnectionConfigSchema>;

export const teamsConnectionSecretsSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .min(1, "Enter the Teams Workflows webhook URL.")
    .max(WEBHOOK_URL_MAX_LENGTH)
    .superRefine((value, context) => {
      const checked = checkTeamsWebhookUrl(value);
      if (!checked.ok) {
        context.addIssue({ code: "custom", message: checked.error });
      }
    }),
});
export type TeamsConnectionSecrets = z.infer<
  typeof teamsConnectionSecretsSchema
>;

export const TEAMS_CONNECTION_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "webhookUrl",
    label: "Workflows webhook URL",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description:
      'In the Teams channel open ••• > Workflows, pick the "Send webhook alerts to a channel" template (trigger "When a Teams webhook request is received") and copy the URL it shows. Office 365 connector URLs (*.webhook.office.com) were retired in 2026 and are not accepted. "Test" posts a test card to the channel.',
    placeholder:
      "https://….environment.api.powerplatform.com/powerautomate/automations/direct/workflows/…",
  },
];

type TeamsProviderContext = ProviderContext<
  TeamsConnectionConfig,
  TeamsConnectionSecrets
>;

/** "save" checks the URL only; "test" also posts a test card to the channel. */
export async function validateTeamsConnection(
  context: TeamsProviderContext,
  reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<TeamsConnectionConfig>> {
  const webhookUrl = checkTeamsWebhookUrl(
    context.connection.secrets.webhookUrl
  );
  if (!webhookUrl.ok) {
    return { ok: false, error: webhookUrl.error };
  }
  if (reason === ValidateConnectionReason.Save) {
    return { ok: true, account: null };
  }
  const response = await postTeamsMessage(
    context.http,
    webhookUrl.value,
    buildTeamsMessage(buildTestCardContent(context.connection.name))
  );
  if (response.ok) {
    return { ok: true, account: null };
  }
  context.log.warn("Teams test message was not accepted", {
    connectionId: context.connection.id,
    status: response.status,
  });
  return { ok: false, error: describeTeamsFailure(response) };
}
