import { verifyStandardWebhook, verifyStaticToken } from "../../inbound-auth";
import type {
  InboundParseResult,
  InboundRequest,
  InboundSecretContext,
  InboundVerification,
  ProviderContext,
} from "../../types";
import type {
  WebhookConnectionConfig,
  WebhookConnectionSecrets,
} from "./connection";
import {
  buildWebhookInboundEvent,
  resolveWebhookDeliveryId,
  WebhookTriggerType,
} from "./inbound-event";
import { parseWebhookRequestBody } from "./request-payload";

/**
 * Inbound side of the generic HTTPS provider. A request is accepted when it
 * carries a valid Standard Webhooks signature, or (for callers that cannot
 * sign) the inbound secret in the X-AgentFlow-Token header. A request that
 * presents a signature is never downgraded to token checking.
 */

const SIGNATURE_HEADERS = ["webhook-signature", "svix-signature"] as const;

export function verifyWebhookRequest(
  request: InboundRequest,
  context: InboundSecretContext<WebhookConnectionConfig>
): InboundVerification {
  const signed = SIGNATURE_HEADERS.some((header) =>
    request.headers.has(header)
  );
  if (signed) {
    return verifyStandardWebhook(
      request.rawBody,
      request.headers,
      context.inboundSecret
    );
  }
  return verifyStaticToken(request.headers, context.inboundSecret);
}

/** An invalid body yields no events and an `invalid_payload: ...` reason (the route still answers 200). */
export function parseWebhookRequest(
  request: InboundRequest,
  context: ProviderContext<WebhookConnectionConfig, WebhookConnectionSecrets>
): Promise<InboundParseResult> {
  const body = parseWebhookRequestBody(request.rawBody);
  const deliveryId = resolveWebhookDeliveryId(
    request.headers,
    body.ok ? body.value : null,
    request.rawBody
  );
  if (!body.ok) {
    return Promise.resolve({
      deliveryId,
      eventType: WebhookTriggerType.Request,
      events: [],
      ignoredReason: `invalid_payload: ${body.error}`,
    });
  }
  return Promise.resolve({
    deliveryId,
    eventType: WebhookTriggerType.Request,
    events: [
      buildWebhookInboundEvent(body.value, {
        deliveryId,
        occurredAt: context.now(),
      }),
    ],
  });
}
