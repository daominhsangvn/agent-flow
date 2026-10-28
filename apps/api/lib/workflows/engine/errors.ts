import type {
  WorkflowRunError,
  WorkflowRunErrorCode,
} from "@repo/api/src/types/workflow";
import { parseError } from "@repo/observability/error";
import {
  collectSecretValues,
  scrubSecretValues,
} from "@/lib/integrations/connection/secrets";

/** Upper bound for stored error messages (run errors, action lastError). */
export const ERROR_MESSAGE_MAX_LENGTH = 1000;

export function runError(
  code: WorkflowRunErrorCode,
  message: string
): WorkflowRunError {
  return { code, message: trimMessage(message) };
}

/** Trims a message to ERROR_MESSAGE_MAX_LENGTH characters with an ellipsis. */
export function trimMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length <= ERROR_MESSAGE_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

/**
 * Error text from provider code, with the connection's secret values removed
 * and trimmed, ready to persist (run errors, action lastError, poll errors).
 */
export function scrubProviderError(
  error: unknown,
  secrets: Record<string, unknown>
): string {
  const message = typeof error === "string" ? error : parseError(error);
  return trimMessage(
    scrubSecretValues(message, collectSecretValues(secrets)) || "Unknown error"
  );
}

/** An agent's runner never asked for its integration tools (an older runner). */
export const RUNNER_WITHOUT_TOOLS =
  "The runner did not open the agent's integration tools, so the agent could not act: update the runner (rebuild its image) and retry.";
