import type { JsonObject } from "@repo/api/src/types/common";
import {
  type IntegrationAccountSummary,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import { jsonObjectSchema, parseJsonObject } from "@/lib/json-schema";
import type { IntegrationAccount } from "../types";
import type { CredentialHints } from "./secrets";

/**
 * Validated readers for the JSON / VarChar columns of integration_connections
 * and integration_deliveries. Rows are written by this module family only,
 * but a row that does not parse degrades to a safe default instead of
 * crashing a listing.
 */

const storedAccountSchema = z.object({
  externalAccountId: z.string().min(1),
  displayName: z.string().nullable().catch(null),
  aliases: z.array(z.string()).catch([]),
  details: jsonObjectSchema.catch({}),
});

const credentialHintsSchema = z.record(z.string(), z.string().nullable());

const connectionStatusSchema = z
  .enum(IntegrationConnectionStatus)
  .catch(IntegrationConnectionStatus.Error);
const deliveryModeSchema = z
  .enum(IntegrationDeliveryMode)
  .catch(IntegrationDeliveryMode.None);
const deliverySourceSchema = z
  .enum(IntegrationDeliverySource)
  .catch(IntegrationDeliverySource.Webhook);
const deliveryOutcomeSchema = z
  .enum(IntegrationDeliveryOutcome)
  .catch(IntegrationDeliveryOutcome.Error);

export function toJsonObject(value: unknown): JsonObject {
  return parseJsonObject(value) ?? {};
}

export function parseStoredAccount(value: unknown): IntegrationAccount | null {
  const parsed = storedAccountSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAccountSummary(
  account: IntegrationAccount | null
): IntegrationAccountSummary | null {
  if (!account) {
    return null;
  }
  return {
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
  };
}

export function parseCredentialHints(value: unknown): CredentialHints {
  const parsed = credentialHintsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function parseConnectionStatus(
  value: string
): IntegrationConnectionStatus {
  return connectionStatusSchema.parse(value);
}

export function parseDeliveryMode(value: string): IntegrationDeliveryMode {
  return deliveryModeSchema.parse(value);
}

export function parseDeliverySource(value: string): IntegrationDeliverySource {
  return deliverySourceSchema.parse(value);
}

export function parseDeliveryOutcome(
  value: string
): IntegrationDeliveryOutcome {
  return deliveryOutcomeSchema.parse(value);
}
