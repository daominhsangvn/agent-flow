export type PollOptions = {
  /** What is being waited for; used in the timeout error. */
  description: string;
  timeoutMs: number;
  intervalMs?: number;
  /** Extra context appended to the timeout error (e.g. the last value seen). */
  describeLastAttempt?: () => string;
};

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Thrown by a probe to stop polling immediately, e.g. when the awaited state
 * can no longer be reached. pollUntil rethrows it as is.
 */
export class PollAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollAbortError";
  }
}

/**
 * Calls `probe` until it returns a non-null value or the timeout elapses. A
 * probe that throws counts as a miss, so transient network errors while a dev
 * server compiles a route do not abort the wait; the last error is reported
 * on timeout. Throw PollAbortError from the probe to fail fast instead.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null>,
  {
    description,
    timeoutMs,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    describeLastAttempt,
  }: PollOptions
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (true) {
    try {
      const value = await probe();
      if (value !== null) {
        return value;
      }
      lastError = null;
    } catch (error) {
      if (error instanceof PollAbortError) {
        throw error;
      }
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        formatTimeoutMessage({
          description,
          timeoutMs,
          lastError,
          lastAttempt: describeLastAttempt?.(),
        })
      );
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatTimeoutMessage({
  description,
  timeoutMs,
  lastError,
  lastAttempt,
}: {
  description: string;
  timeoutMs: number;
  lastError: unknown;
  lastAttempt: string | undefined;
}): string {
  const parts = [`Timed out after ${timeoutMs}ms waiting for ${description}.`];
  if (lastAttempt) {
    parts.push(`Last attempt: ${lastAttempt}`);
  }
  if (lastError) {
    parts.push(
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
  return parts.join(" ");
}
