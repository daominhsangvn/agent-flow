import { z } from "zod";

/**
 * A running turn keeps its time limit in `orchestrator_turns.usage` until it
 * finishes (then usage holds its cost and tokens).
 */

const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;

const runningUsageSchema = z.object({ timeoutMs: z.number().int().positive() });

export function readTurnTimeoutMs(usage: unknown): number {
  const parsed = runningUsageSchema.safeParse(usage);
  return parsed.success ? parsed.data.timeoutMs : DEFAULT_TURN_TIMEOUT_MS;
}
