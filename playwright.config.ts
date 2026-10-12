import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { getAppBaseUrl } from "./e2e/helpers/api-url";
import { AUTH_STATE_PATH } from "./e2e/helpers/better-auth";
import { readEnv } from "./e2e/helpers/env";
import { EXTERNAL_TAG_PATTERN } from "./e2e/helpers/tags";

// Playwright does not load .env.local the way Next.js does. The web app's env
// provides NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_API_URL, which the harness uses
// for BASE_URL and the API origin (e2e/helpers/api-url.ts). Shell variables
// win (override: false). Resolved from this file so any cwd works.
loadEnv({
  path: path.resolve(import.meta.dirname, "apps", "app", ".env.local"),
  override: false,
  quiet: true,
});

const includeExternal = readEnv("E2E_INCLUDE_EXTERNAL") === "1";

// WARNING: test-results/ may contain session screenshots from authenticated pages — do not upload to public artifact stores

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  outputDir: "test-results",
  globalSetup: "./e2e/global.setup.ts",
  // Top-level retries apply to projects that don't set their own.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: getAppBaseUrl(),
    trace: process.env.CI ? "on-first-retry" : "off",
    screenshot: process.env.CI ? "only-on-failure" : "off",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      // Signs in (or signs up) once; retrying would repeat real sign-ins,
      // which Better Auth rate-limits in production builds.
      retries: 0,
    },
    {
      name: "chromium",
      // Only *.spec.ts: vitest unit tests for the helpers live next to them.
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ["setup"],
      // auth.spec.ts submits real credentials through the sign-in form.
      retries: 0,
      // @external specs need Liveblocks or a connected desktop compute target.
      grepInvert: includeExternal ? undefined : EXTERNAL_TAG_PATTERN,
    },
  ],
});
