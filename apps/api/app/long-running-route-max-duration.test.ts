/**
 * Every route a client calls with `LONG_RUNNING_API_TIMEOUT_MS` must declare
 * the matching serverless ceiling (PR #4321 review).
 *
 * The client-side deadline's whole justification is that 5 minutes is the
 * `maxDuration` the route runs under, so a request outliving it cannot still be
 * doing useful work. Before this test the routes declared nothing and ran on
 * the platform default, so the function was terminated first and the user saw a
 * 504 long before the client deadline could state the honest "we stopped
 * waiting". This pins the two numbers together.
 */

import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { describe, expect, it } from "vitest";
import { maxDuration as selectedPullRequestDiffMaxDuration } from "./branches/[id]/selected-pull-request/diff/route";
import { maxDuration as selectedPullRequestFilesMaxDuration } from "./branches/[id]/selected-pull-request/files/route";
import { maxDuration as packRepoImportMaxDuration } from "./catalog/[id]/import-repo/route";
import { maxDuration as packZipImportMaxDuration } from "./catalog/[id]/import-zip/route";
import { maxDuration as githubBackfillMaxDuration } from "./integrations/github/backfill/route";
import { maxDuration as googleImportMaxDuration } from "./integrations/google/import/route";

const LONG_RUNNING_MAX_DURATION_SECONDS = LONG_RUNNING_API_TIMEOUT_MS / 1000;

describe("long-running routes declare the client deadline's ceiling", () => {
  it("selected-PR reads run under the ceiling their shared hooks wait for", () => {
    expect(selectedPullRequestFilesMaxDuration).toBe(
      LONG_RUNNING_MAX_DURATION_SECONDS
    );
    expect(selectedPullRequestDiffMaxDuration).toBe(
      LONG_RUNNING_MAX_DURATION_SECONDS
    );
  });

  it("GitHub backfill runs under the 5-minute ceiling the client waits for", () => {
    expect(githubBackfillMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("Google Drive folder import runs under the 5-minute ceiling the client waits for", () => {
    expect(googleImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("pack zip import runs under the 5-minute ceiling the client waits for", () => {
    expect(packZipImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("pack repo import runs under the 5-minute ceiling the client waits for", () => {
    expect(packRepoImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });
});
