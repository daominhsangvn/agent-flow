/**
 * Test tags (Playwright `tag` option).
 *
 * - Smoke: the minimal suite that needs only Postgres plus the app and API
 *   dev servers. `pnpm test:e2e:smoke` runs exactly these.
 * - External: needs services a plain local stack does not have (Liveblocks
 *   rooms on document pages, a connected desktop compute target, a loop
 *   runner secret shared with the API). Skipped unless E2E_INCLUDE_EXTERNAL=1.
 */
export const E2ETag = {
  Smoke: "@smoke",
  External: "@external",
} as const;
export type E2ETag = (typeof E2ETag)[keyof typeof E2ETag];

/** Matches tests tagged External, for the config's grepInvert. */
export const EXTERNAL_TAG_PATTERN = new RegExp(E2ETag.External);
