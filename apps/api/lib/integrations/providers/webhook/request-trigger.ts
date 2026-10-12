import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import {
  defineTrigger,
  type InboundEvent,
  type ProviderContext,
  type SourceItem,
} from "../../types";
import type {
  WebhookConnectionConfig,
  WebhookConnectionSecrets,
} from "./connection";
import {
  buildWebhookInboundEvent,
  sha256Hex,
  WebhookTriggerType,
} from "./inbound-event";
import {
  parseWebhookRequestBody,
  WEBHOOK_REQUEST_TYPE_MAX_LENGTH,
} from "./request-payload";

const TYPES_FILTER_MAX = 50;

export const webhookRequestTriggerConfigSchema = z.object({
  types: z
    .array(z.string().trim().min(1).max(WEBHOOK_REQUEST_TYPE_MAX_LENGTH))
    .max(TYPES_FILTER_MAX)
    .default([]),
});
export type WebhookRequestTriggerConfig = z.infer<
  typeof webhookRequestTriggerConfigSchema
>;

const REQUEST_TRIGGER_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "types",
    label: "Types",
    kind: IntegrationFieldKind.StringList,
    required: false,
    placeholder: "feature",
    description:
      'Start a run only when the request\'s "type" is one of these (case-insensitive). Leave empty to accept every request.',
  },
];

export const webhookRequestTrigger = defineTrigger<
  WebhookRequestTriggerConfig,
  WebhookConnectionConfig
>({
  key: WebhookTriggerType.Request,
  displayName: "HTTPS request received",
  description:
    "Starts a run when an authenticated JSON request (Standard Webhooks signature or token header) reaches the connection's inbound URL.",
  configSchema: webhookRequestTriggerConfigSchema,
  configFields: REQUEST_TRIGGER_FIELDS,
  manualRun: { label: "JSON payload", placeholder: '{"title":"..."}' },
  matches: matchesRequestTypes,
});

/**
 * Manual run input is the same JSON body the inbound URL accepts. Rejects
 * with a user-facing Error when the input is not valid.
 */
export function resolveManualWebhookEvent(
  context: ProviderContext<WebhookConnectionConfig, WebhookConnectionSecrets>,
  input: string,
  triggerType: string
): Promise<InboundEvent> {
  if (triggerType !== WebhookTriggerType.Request) {
    return Promise.reject(
      new Error(
        `Manual runs are not supported for trigger type "${triggerType}".`
      )
    );
  }
  const body = parseWebhookRequestBody(input);
  if (!body.ok) {
    return Promise.reject(new Error(`Invalid JSON payload: ${body.error}`));
  }
  return Promise.resolve(
    buildWebhookInboundEvent(body.value, {
      deliveryId: `manual:${sha256Hex(input)}`,
      occurredAt: context.now(),
    })
  );
}

/** Webhook items exist only inside the request; the engine uses InboundEvent.inlineItem. */
export function fetchWebhookItem(): Promise<SourceItem> {
  return Promise.reject(new Error("Webhook items are carried inline"));
}

function matchesRequestTypes(
  event: InboundEvent,
  config: WebhookRequestTriggerConfig
): boolean {
  if (config.types.length === 0) {
    return true;
  }
  const type = event.attributes.type;
  if (typeof type !== "string") {
    return false;
  }
  const wanted = type.toLowerCase();
  return config.types.some((candidate) => candidate.toLowerCase() === wanted);
}
