/**
 * @file headless-model-provider.ts
 * @description The runner's model provider as set in AgentFlow (Settings →
 * computers → Model provider), for the System Check's Claude authentication
 * row. AgentFlow sends that provider with every loop, so a runner that has one
 * needs no Claude credential of its own; without this lookup the row could
 * only report what is on the runner's disk and stayed a warning forever.
 */

import { ModelProviderMode } from "@repo/api/src/types/compute-target-model-provider";
import { z } from "zod";
import type {
  AgentFlowModelProvider,
  AgentFlowModelProviderLookup,
} from "../server/operations/health-check-claude-auth.js";

export type RunnerModelProviderLookupDeps = {
  apiUrl: string;
  apiKey: string;
  /** Null until the runner has registered. */
  getComputeTargetId: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Reads `GET /compute-targets/{id}/model-provider` as the runner's own user
 * (the API key's owner owns the compute target). Only the mode and the base
 * URL's host are kept; the token never leaves the API. Any failure answers
 * null, which leaves the row to the runner's own credential.
 */
export function createRunnerModelProviderLookup(
  deps: RunnerModelProviderLookupDeps
): AgentFlowModelProviderLookup {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async () => {
    const computeTargetId = deps.getComputeTargetId();
    if (!computeTargetId) {
      return null;
    }
    const url = `${deps.apiUrl.replace(TRAILING_SLASHES_RE, "")}/compute-targets/${encodeURIComponent(computeTargetId)}/model-provider`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${deps.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const parsed = modelProviderResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    return parsed.success ? toModelProvider(parsed.data.data) : null;
  };
}

const DEFAULT_TIMEOUT_MS = 5000;
const TRAILING_SLASHES_RE = /\/+$/;

/** The API's success envelope, lenient about fields this lookup ignores. */
const modelProviderResponseSchema = z.object({
  data: z.object({
    mode: z.string(),
    baseUrl: z.string().nullable(),
  }),
});

function toModelProvider(
  provider: z.infer<typeof modelProviderResponseSchema>["data"]
): AgentFlowModelProvider | null {
  if (provider.mode !== ModelProviderMode.Custom || !provider.baseUrl) {
    return null;
  }
  try {
    return { host: new URL(provider.baseUrl).host };
  } catch {
    return null;
  }
}
