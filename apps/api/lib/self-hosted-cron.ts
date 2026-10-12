import { randomBytes } from "node:crypto";

/**
 * In-process scheduler for self-hosted installs (no Vercel cron). Started by
 * server.ts after the HTTP server listens; it calls the API's own cron routes
 * over loopback HTTP with `Authorization: Bearer $CRON_SECRET`, so the work
 * runs inside the Next.js route module graph like any other request.
 *
 * - `SELF_HOSTED_CRON_DISABLED=true` turns it off (an external scheduler
 *   calls the cron routes instead; CRON_SECRET must then be set).
 * - Without CRON_SECRET an ephemeral secret is generated for this process.
 * - A job never overlaps with itself: the next run is scheduled when the
 *   previous one finished. Timers are unref'd and never keep the process up.
 *
 * server.ts runs under tsx outside Next.js, so this module only uses Node
 * built-ins (no `@/` alias, no `server-only` imports).
 */

export type SelfHostedCronJob = { path: string; intervalMs: number };

/** The environment variables the runner reads (process.env by default). */
export type SelfHostedCronEnv = Record<string, string | undefined>;

export type SelfHostedCronLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type SelfHostedCronOptions = {
  port: number;
  /** The address the server listens on; wildcard addresses map to 127.0.0.1. */
  hostname?: string;
  env?: SelfHostedCronEnv;
  fetchImpl?: typeof fetch;
  logger?: SelfHostedCronLogger;
  initialDelayMs?: number;
};

export const SELF_HOSTED_CRON_INITIAL_DELAY_MS = 15_000;
export const SELF_HOSTED_CRON_REQUEST_TIMEOUT_MS = 120_000;
export const WORKFLOW_TICK_DEFAULT_SECONDS = 10;
export const WORKFLOW_TICK_MIN_SECONDS = 5;
export const TIMEOUT_LOOPS_INTERVAL_MS = 5 * 60_000;
/** Hourly, as the hosted cron schedule runs the stale-session reaper. */
export const STALE_SESSIONS_INTERVAL_MS = 60 * 60_000;

const LOG_PREFIX = "[self-hosted-cron]";

/** Starts the runner and returns a function that stops it. */
export function startSelfHostedCronRunner(
  options: SelfHostedCronOptions
): () => void {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  if (env.SELF_HOSTED_CRON_DISABLED === "true") {
    logger.info(
      `${LOG_PREFIX} Disabled by SELF_HOSTED_CRON_DISABLED; cron routes must be called externally.`
    );
    return () => undefined;
  }

  const secret = ensureCronSecret(env, logger);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = `http://${resolveCronHost(options.hostname)}:${options.port}`;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const runJob = async (job: SelfHostedCronJob): Promise<void> => {
    // Next.js' dev server reloads the .env files after some code changes and
    // resets process.env to them, which drops a generated secret: without it
    // back, every later call would answer 500 until the server restarts.
    if (env.CRON_SECRET !== secret) {
      env.CRON_SECRET = secret;
    }
    try {
      const response = await fetchImpl(`${baseUrl}${job.path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(SELF_HOSTED_CRON_REQUEST_TIMEOUT_MS),
      });
      // Drain the body so the connection is released.
      await response.text();
      if (!response.ok) {
        logger.warn(
          `${LOG_PREFIX} ${job.path} answered HTTP ${response.status}`
        );
      }
    } catch (error) {
      logger.warn(`${LOG_PREFIX} ${job.path} failed: ${describeError(error)}`);
    }
  };

  const schedule = (job: SelfHostedCronJob, delayMs: number): void => {
    if (stopped) {
      return;
    }
    const timer = setTimeout(async () => {
      timers.delete(timer);
      await runJob(job);
      schedule(job, job.intervalMs);
    }, delayMs);
    timer.unref();
    timers.add(timer);
  };

  const jobs = resolveSelfHostedCronJobs(env);
  for (const job of jobs) {
    schedule(job, options.initialDelayMs ?? SELF_HOSTED_CRON_INITIAL_DELAY_MS);
  }
  logger.info(
    `${LOG_PREFIX} Started: ${jobs.map((job) => `${job.path} every ${Math.round(job.intervalMs / 1000)}s`).join(", ")}`
  );

  return () => {
    stopped = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}

/**
 * Jobs and intervals: workflows every WORKFLOW_TICK_SECONDS, loop reaper every
 * 5 min, and the stale-session reaper hourly (agent sessions whose machine
 * stopped reporting before it sent their end).
 */
export function resolveSelfHostedCronJobs(
  env: SelfHostedCronEnv
): SelfHostedCronJob[] {
  return [
    { path: "/cron/workflows", intervalMs: workflowTickSeconds(env) * 1000 },
    { path: "/cron/timeout-loops", intervalMs: TIMEOUT_LOOPS_INTERVAL_MS },
    {
      path: "/cron/reconcile-stale-sessions",
      intervalMs: STALE_SESSIONS_INTERVAL_MS,
    },
  ];
}

/** Loopback address that reaches a server listening on `hostname`. */
export function resolveCronHost(hostname: string | undefined): string {
  const host = hostname?.trim() ?? "";
  if (host === "" || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}

function workflowTickSeconds(env: SelfHostedCronEnv): number {
  const raw = env.WORKFLOW_TICK_SECONDS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return WORKFLOW_TICK_DEFAULT_SECONDS;
  }
  return Math.max(WORKFLOW_TICK_MIN_SECONDS, parsed);
}

/** The configured CRON_SECRET, or an ephemeral one stored in env for this process. */
function ensureCronSecret(
  env: SelfHostedCronEnv,
  logger: SelfHostedCronLogger
): string {
  const configured = env.CRON_SECRET;
  if (configured && configured.trim() !== "") {
    return configured;
  }
  const generated = randomBytes(32).toString("base64url");
  env.CRON_SECRET = generated;
  logger.info(
    `${LOG_PREFIX} CRON_SECRET is not set; generated an ephemeral secret for this process. Set CRON_SECRET to call /cron/* routes from another scheduler.`
  );
  return generated;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultLogger: SelfHostedCronLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};
