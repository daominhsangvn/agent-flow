import { log } from "@repo/observability/log";
import { loadConnectionByInboundKey } from "@/lib/integrations/connection-service";
import type { InboundRequest } from "@/lib/integrations/types";
import { readCappedRequestText } from "@/lib/route-utils";
import {
  handleInboundDelivery,
  inboundIgnoredReason,
  verifyInboundRequest,
} from "../handlers/inbound-delivery-handler";
import { completeIngress, IngressOutcome } from "../ingress-response";

/**
 * POST /webhooks/integrations/{inboundKey} — public ingress for integration
 * connections in webhook mode (Jira, Azure DevOps, generic HTTPS). No session
 * auth: the opaque inbound key selects the connection (and with it the
 * organization) and the provider verifies the request against the
 * connection's inbound secret, in constant time.
 *
 * Statuses: 404 for an unknown key, 401 when verification fails, 413 for a
 * body over 1 MB, 400 for a payload the provider cannot parse, 200 otherwise —
 * including deliveries that are ignored, so Jira stops retrying and Azure
 * DevOps does not put the subscription on probation. Runs advance in the
 * background after the 200.
 */

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(
  request: Request,
  context: { params: Promise<{ inboundKey?: string }> }
): Promise<Response> {
  try {
    const { inboundKey } = await context.params;
    const connection = inboundKey
      ? await loadConnectionByInboundKey(inboundKey)
      : null;
    if (!connection) {
      return completeIngress({
        status: 404,
        outcome: IngressOutcome.UnknownInboundKey,
      });
    }
    const ignored = inboundIgnoredReason(connection);
    if (ignored) {
      return completeIngress({
        status: 200,
        outcome: IngressOutcome.Ignored,
        connection,
        fields: { reason: ignored },
      });
    }

    const body = await readCappedRequestText(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return completeIngress({
        status: 413,
        outcome: IngressOutcome.PayloadTooLarge,
        connection,
      });
    }
    const inboundRequest: InboundRequest = {
      rawBody: body.value,
      headers: request.headers,
      url: new URL(request.url),
    };
    const verification = await verifyInboundRequest(connection, inboundRequest);
    if (!verification.ok) {
      return completeIngress({
        status: 401,
        outcome: IngressOutcome.Unauthorized,
        connection,
        fields: { reason: verification.reason },
      });
    }

    const result = await handleInboundDelivery(connection, inboundRequest);
    if (!result.ok) {
      return completeIngress({
        status: 400,
        outcome: result.reason,
        connection,
      });
    }
    return completeIngress({
      status: 200,
      outcome: result.ingest.outcome,
      connection,
      fields: {
        deliveryId: result.deliveryId,
        eventType: result.eventType,
        runCount: result.ingest.runCount,
        detail: result.ingest.detail,
      },
    });
  } catch (error) {
    log.error("[webhook/integrations] Webhook handling failed", { error });
    return completeIngress({ status: 500, outcome: IngressOutcome.Error });
  }
}
