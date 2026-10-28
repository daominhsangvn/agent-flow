import type {
  IntegrationDelivery,
  IntegrationSecretFieldState,
} from "@repo/api/src/types/integration";
import type {
  IntegrationConnection as IntegrationConnectionRecord,
  IntegrationDelivery as IntegrationDeliveryRecord,
} from "@repo/database";
import { getIntegrationProvider } from "../registry";
import { getSecretFieldKeys } from "./secrets";
import {
  parseCredentialHints,
  parseDeliveryOutcome,
  parseDeliverySource,
} from "./stored-json";

/**
 * Pieces of the connection service's wire DTOs: the write-only secret state
 * of a connection and a delivery row, plus the delivery listing's page size.
 */

export const DELIVERIES_DEFAULT_LIMIT = 50;
const DELIVERIES_MAX_LIMIT = 200;

/** Every secret field of the provider: set or not, and the last four characters. */
export function toSecretFieldStates(
  record: IntegrationConnectionRecord
): Record<string, IntegrationSecretFieldState> {
  return toSecretFieldStatesFromHints(record.provider, record.credentialHints);
}

/** The secret field states of stored credential hints (a connection's or a project connection's). */
export function toSecretFieldStatesFromHints(
  providerKey: string,
  credentialHints: unknown
): Record<string, IntegrationSecretFieldState> {
  const hints = parseCredentialHints(credentialHints);
  const provider = getIntegrationProvider(providerKey);
  const keys = provider
    ? getSecretFieldKeys(provider.connection.fields)
    : Object.keys(hints);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        isSet: Object.hasOwn(hints, key),
        lastFour: hints[key] ?? null,
      },
    ])
  );
}

export function toDeliveryDto(
  record: IntegrationDeliveryRecord
): IntegrationDelivery {
  return {
    id: record.id,
    deliveryId: record.deliveryId,
    source: parseDeliverySource(record.source),
    eventType: record.eventType,
    outcome: parseDeliveryOutcome(record.outcome),
    detail: record.detail,
    runCount: record.runCount,
    receivedAt: record.receivedAt,
  };
}

export function clampDeliveriesLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DELIVERIES_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(limit)), DELIVERIES_MAX_LIMIT);
}
