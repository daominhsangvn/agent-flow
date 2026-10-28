import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { z } from "zod";
import type { AnyProvider } from "../registry";
import type {
  InboundSetupContext,
  ProviderContext,
  ValidateConnectionReason,
  ValidateConnectionResult,
} from "../types";
import {
  collectSecretValues,
  getSecretFieldKeys,
  omitKeys,
  scrubSecretValues,
} from "./secrets";

/**
 * Guards around provider code used by the connection service: config and
 * secrets parsing with the provider's schemas, delivery-mode support, and
 * calls into provider hooks that must never take a request down if a
 * provider throws despite its contract.
 */

const VALIDATE_THREW_MESSAGE =
  "The connection could not be validated. Check the settings and try again.";

export function checkDeliveryMode(
  provider: AnyProvider,
  mode: IntegrationDeliveryMode
): Result<IntegrationDeliveryMode, string> {
  if (
    mode === IntegrationDeliveryMode.None ||
    supportsDeliveryMode(provider, mode)
  ) {
    return Result.ok(mode);
  }
  return Result.err(
    `${provider.displayName} does not support the "${mode}" delivery mode`
  );
}

/** Parses non-secret config; secret field keys are dropped first. */
export function parseConnectionConfig(
  provider: AnyProvider,
  config: Record<string, unknown>
): Result<JsonObject, string> {
  const secretKeys = getSecretFieldKeys(provider.connection.fields);
  return parseWithSchema(
    provider.connection.configSchema,
    omitKeys(config, secretKeys),
    "Invalid configuration"
  );
}

export function parseConnectionSecrets(
  provider: AnyProvider,
  secrets: Record<string, unknown>
): Result<JsonObject, string> {
  return parseWithSchema(
    provider.connection.secretsSchema,
    secrets,
    "Invalid credentials"
  );
}

/**
 * Calls the provider's validate(). A provider error message is returned with
 * every known secret value scrubbed; a throw becomes a generic failure.
 */
export async function runProviderValidation(
  provider: AnyProvider,
  context: ProviderContext,
  reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<JsonObject>> {
  try {
    const result = await provider.connection.validate(context, reason);
    if (result.ok) {
      return result;
    }
    return {
      ok: false,
      error: scrubSecretValues(
        result.error,
        collectSecretValues(context.connection.secrets)
      ),
    };
  } catch (error) {
    context.log.warn("Provider validate threw", {
      reason,
      error: parseError(error),
    });
    return { ok: false, error: VALIDATE_THREW_MESSAGE };
  }
}

/** Provider markdown for the inbound panel; empty without an inbound side. */
export function renderSetupInstructions(
  provider: AnyProvider | null,
  context: InboundSetupContext
): string {
  if (!provider?.inbound) {
    return "";
  }
  try {
    return provider.inbound.setupInstructions(context);
  } catch (error) {
    log.warn("[integrations] Provider setupInstructions threw", {
      provider: provider.key,
      connectionId: context.connection.id,
      error: scrubSecretValues(parseError(error), [context.inboundSecret]),
    });
    return "";
  }
}

function supportsDeliveryMode(
  provider: AnyProvider,
  mode: IntegrationDeliveryMode
): boolean {
  const inbound = provider.inbound;
  if (!inbound?.deliveryModes.includes(mode)) {
    return false;
  }
  if (mode === IntegrationDeliveryMode.Webhook) {
    return Boolean(inbound.verify && inbound.parse);
  }
  return Boolean(inbound.poll);
}

export function parseWithSchema(
  schema: z.ZodType<JsonObject>,
  value: unknown,
  label: string
): Result<JsonObject, string> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return Result.err(`${label}: ${formatIssues(parsed.error.issues)}`);
  }
  return Result.ok(parsed.data);
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
}
