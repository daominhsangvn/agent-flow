/**
 * The tailer knobs `output-tailer.ts` reads through `parseEnvNumber`. Saved and
 * restored as a set so a suite that overrides them cannot clobber an ambient
 * value the host had configured.
 */
export const TAILER_ENV_KEYS = [
  "AGENTFLOW_TAILER_POLL_MS",
  "AGENTFLOW_TAILER_THROTTLE_MS",
  "AGENTFLOW_TAILER_AUTH_RETRY_BASE_MS",
  "AGENTFLOW_TAILER_AUTH_RETRY_MAX_MS",
  "AGENTFLOW_TAILER_AUTH_RETRY_MAX_COUNT",
] as const;
