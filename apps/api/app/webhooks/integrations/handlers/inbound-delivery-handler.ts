import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { log } from "@repo/observability/log";
import {
  createProviderContext,
  type LoadedConnection,
} from "@/lib/integrations/connection-service";
import { createProviderHttp } from "@/lib/integrations/http";
import type {
  InboundRequest,
  InboundVerification,
} from "@/lib/integrations/types";
import {
  type IngestResult,
  ingestEvents,
  toDeliveryPayload,
} from "@/lib/workflows/engine/ingest";

/**
 * Provider-agnostic handling of POST /webhooks/integrations/{inboundKey}:
 * whether the connection accepts webhooks at all, the provider's
 * constant-time verification, then parse + ingest. The route owns HTTP
 * statuses and the terminal outcome log.
 */

export type InboundConnection = LoadedConnection & { inboundSecret: string };

export const InboundIgnoredReason = {
  ConnectionDisabled: "connection_disabled",
  NotWebhookMode: "not_webhook_mode",
  NoInboundSupport: "no_inbound_support",
} as const;
export type InboundIgnoredReason =
  (typeof InboundIgnoredReason)[keyof typeof InboundIgnoredReason];

/** Why a delivery that reached the provider code was rejected. */
export const InboundRejection = {
  NoVerifier: "no_verifier",
  VerificationError: "verification_error",
  InvalidPayload: "invalid_payload",
} as const;
export type InboundRejection =
  (typeof InboundRejection)[keyof typeof InboundRejection];

export type InboundDeliveryResult =
  | { ok: false; reason: InboundRejection | InboundIgnoredReason }
  | {
      ok: true;
      deliveryId: string;
      eventType: string | null;
      ingest: IngestResult;
    };

/** Why a delivery to this connection is acknowledged without processing, or null. */
export function inboundIgnoredReason(
  connection: InboundConnection
): InboundIgnoredReason | null {
  if (connection.record.status === IntegrationConnectionStatus.Disabled) {
    return InboundIgnoredReason.ConnectionDisabled;
  }
  if (connection.record.deliveryMode !== IntegrationDeliveryMode.Webhook) {
    return InboundIgnoredReason.NotWebhookMode;
  }
  const inbound = connection.provider.inbound;
  if (!(inbound?.verify && inbound.parse)) {
    return InboundIgnoredReason.NoInboundSupport;
  }
  return null;
}

/** The provider's verification with the connection's inbound secret. Never rejects. */
export async function verifyInboundRequest(
  connection: InboundConnection,
  request: InboundRequest
): Promise<InboundVerification> {
  const verify = connection.provider.inbound?.verify;
  if (!verify) {
    return { ok: false, reason: InboundRejection.NoVerifier };
  }
  const { runtime } = connection;
  try {
    return await verify(request, {
      connection: {
        id: runtime.id,
        provider: runtime.provider,
        name: runtime.name,
        config: runtime.config,
        account: runtime.account,
      },
      inboundSecret: connection.inboundSecret,
      http: createProviderHttp(),
      now: () => new Date(),
    });
  } catch (error) {
    log.warn("[handleInboundDelivery] Verification threw", {
      connectionId: runtime.id,
      provider: runtime.provider,
      error,
    });
    return { ok: false, reason: InboundRejection.VerificationError };
  }
}

/** Parses a verified request and ingests its events. */
export async function handleInboundDelivery(
  connection: InboundConnection,
  request: InboundRequest
): Promise<InboundDeliveryResult> {
  const parse = connection.provider.inbound?.parse;
  if (!parse) {
    return { ok: false, reason: InboundIgnoredReason.NoInboundSupport };
  }
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse(
      request,
      createProviderContext(connection.runtime, LOG_PREFIX)
    );
  } catch (error) {
    log.warn("[handleInboundDelivery] Payload could not be parsed", {
      connectionId: connection.runtime.id,
      provider: connection.runtime.provider,
      error,
    });
    return { ok: false, reason: InboundRejection.InvalidPayload };
  }
  const ingest = await ingestEvents({
    connection,
    source: IntegrationDeliverySource.Webhook,
    deliveryId: parsed.deliveryId,
    eventType: parsed.eventType,
    events: parsed.events,
    payload: toDeliveryPayload(request.rawBody),
    ignoredReason: parsed.ignoredReason,
  });
  return {
    ok: true,
    deliveryId: parsed.deliveryId,
    eventType: parsed.eventType,
    ingest,
  };
}

const LOG_PREFIX = "[webhook/integrations]";
