import { log } from "@repo/observability/log";

/**
 * Keep background work alive past the response.
 *
 * The hosted product ran on Vercel serverless, where `waitUntil` from
 * `@vercel/functions` extended the invocation lifetime. Self-hosted deployments
 * run `next start` as a long-lived Node process, so the promise keeps running on
 * its own; what still matters is that a rejection is observed — an unhandled
 * rejection would terminate the process.
 *
 * Call sites keep the same shape as before (`waitUntil(promise)`), so the
 * "never fire-and-forget; always wrap with waitUntil" rule still applies.
 */
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch((error: unknown) => {
    log.error("[waitUntil] background task failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
