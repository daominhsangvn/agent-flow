/**
 * Feature flags set by the deployment instead of PostHog. A self-hosted
 * install often runs without PostHog, where every flag-gated feature stays
 * off; these lists turn features on (or off) for the whole deployment:
 *
 * - `AGENTFLOW_FEATURE_FLAGS` — server-side checks (API routes, ingest);
 * - `NEXT_PUBLIC_AGENTFLOW_FEATURE_FLAGS` — the web app's UI.
 *
 * Flag keys separated by commas or spaces; a key prefixed with `-` is forced
 * off. An override wins over PostHog; keys not listed are evaluated as usual.
 */

const SEPARATOR_RE = /[\s,]+/;
const OFF_PREFIX = "-";

export function parseFeatureFlagOverrides(
  value: string | undefined
): ReadonlyMap<string, boolean> {
  const overrides = new Map<string, boolean>();
  for (const token of (value ?? "").split(SEPARATOR_RE)) {
    const off = token.startsWith(OFF_PREFIX);
    const key = off ? token.slice(OFF_PREFIX.length) : token;
    if (key !== "") {
      overrides.set(key, !off);
    }
  }
  return overrides;
}
