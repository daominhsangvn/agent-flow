import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { generateStandardWebhookSecret } from "../../inbound-auth";
import { defineIntegrationProvider } from "../../types";
import {
  validateWebhookConnection,
  WEBHOOK_CONNECTION_FIELDS,
  type WebhookConnectionConfig,
  type WebhookConnectionSecrets,
  webhookConnectionConfigSchema,
  webhookConnectionSecretsSchema,
} from "./connection";
import { parseWebhookRequest, verifyWebhookRequest } from "./inbound";
import { webhookPostAction } from "./post-action";
import {
  fetchWebhookItem,
  resolveManualWebhookEvent,
  webhookRequestTrigger,
} from "./request-trigger";
import { buildWebhookSetupInstructions } from "./setup-instructions";

/**
 * Generic HTTPS in both directions. Inbound: any system POSTs a JSON body
 * (Standard Webhooks signature or token header) and the item travels inline.
 * Outbound: run events are POSTed as JSON, signed when the connection has a
 * signing secret.
 */
export const webhookProvider = defineIntegrationProvider<
  WebhookConnectionConfig,
  WebhookConnectionSecrets
>({
  key: IntegrationProviderKey.Webhook,
  builtIn: true,
  displayName: "Webhook (HTTPS)",
  description:
    "Start runs from any system that can send an HTTPS request, and send run events to your own HTTPS endpoints. Requests are authenticated with Standard Webhooks signatures or a token header.",
  docsUrl: "https://www.standardwebhooks.com/",
  connection: {
    configSchema: webhookConnectionConfigSchema,
    secretsSchema: webhookConnectionSecretsSchema,
    fields: WEBHOOK_CONNECTION_FIELDS,
    validate: validateWebhookConnection,
  },
  inbound: {
    deliveryModes: [IntegrationDeliveryMode.Webhook],
    generateSecret: generateStandardWebhookSecret,
    setupInstructions: buildWebhookSetupInstructions,
    verify: verifyWebhookRequest,
    parse: parseWebhookRequest,
  },
  source: {
    fetchItem: fetchWebhookItem,
    resolveManual: resolveManualWebhookEvent,
  },
  triggers: [webhookRequestTrigger],
  actions: [webhookPostAction],
});
