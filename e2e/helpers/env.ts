const TRAILING_SLASHES_REGEX = /\/+$/;

/**
 * Reads an environment variable, treating unset, empty and whitespace-only
 * values the same. `.env.local` templates ship keys with empty values (e.g.
 * `DEVOPS_AGENTFLOW_APP_PWD=""`), which `??` alone would not fall through.
 */
export function readEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function stripTrailingSlashes(url: string): string {
  return url.replace(TRAILING_SLASHES_REGEX, "");
}
