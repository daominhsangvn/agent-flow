import type { Prisma } from "@repo/database";

/**
 * Retries of a run step after a temporary failure (docs/workflows.md "Run
 * state machine"): today the import of the source item when the source system
 * is rate limited, down or slow (RetryableSourceError). The run keeps its
 * status; `stepAttempts` counts the failed attempts and `nextStepAt` holds the
 * run back until the backoff elapsed. Both are reset on every status change.
 */

/** Failed attempts after which the step fails the run for good. */
export const STEP_MAX_ATTEMPTS = 5;
/** Delay before attempt n+1 after failed attempt n (30 s, 2 min, 10 min, 30 min). */
export const STEP_RETRY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;

/** Delay after `failedAttempts` failed attempts, or null when none is left. */
export function stepRetryDelayMs(failedAttempts: number): number | null {
  if (failedAttempts >= STEP_MAX_ATTEMPTS) {
    return null;
  }
  const index = Math.min(
    Math.max(failedAttempts, 1) - 1,
    STEP_RETRY_BACKOFF_MS.length - 1
  );
  return STEP_RETRY_BACKOFF_MS[index];
}

/**
 * Runs whose current step may run at `now`: no retry scheduled, or its time
 * has come. Used by advanceRun's lease and the tick's due-run query.
 */
export function stepDueFilter(now: Date): Prisma.WorkflowRunWhereInput {
  return { OR: [{ nextStepAt: null }, { nextStepAt: { lte: now } }] };
}
