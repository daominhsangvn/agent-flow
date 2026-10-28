import { expect, type Page } from "@playwright/test";
import { getApiBaseUrl } from "./api-url";
import {
  decodeSessionClaims,
  getSessionBearerToken,
  waitForSignedInSession,
} from "./better-auth";

const RE_OPEN_ORGANIZATION_SWITCHER = /open organization switcher/i;
const RE_ALL_PROJECTS = /^all projects$/i;
const RE_PROJECT_NAME = /^project name$/i;
const RE_CREATE_PROJECT = /^create project$/i;
const ONBOARDING_PATH_SEGMENT = "/onboarding";
const MY_TASKS_PATH = "/my-tasks";
const AUTHENTICATED_ENTRY_TIMEOUT_MS = 15_000;
const AUTHENTICATED_ENTRY_POLL_MS = 250;
const SHELL_TIMEOUT_MS = 30_000;
const ME_PROBE_BODY_PREVIEW = 500;

type AuthenticatedEntry = "shell" | "onboarding";

export type MeProbeResult = {
  bodyPreview: string | null;
  error: string | null;
  ok: boolean;
  status: number | null;
  url: string;
};

export async function ensureAuthenticatedShellReady(page: Page) {
  await waitForSignedInSession(page);
  await expect(
    page.getByRole("button", { name: RE_OPEN_ORGANIZATION_SWITCHER })
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(page.getByRole("link", { name: RE_ALL_PROJECTS })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
}

export async function gotoAuthenticatedApp(page: Page, path = MY_TASKS_PATH) {
  await warmCurrentUser(page);

  if (path !== MY_TASKS_PATH) {
    await page.goto(path);
    await ensureAuthenticatedShellReady(page);
  }
}

/**
 * GET `${api}/me` with the session JWT, for diagnostics. Never throws.
 */
export async function probeAuthenticatedMe(page: Page): Promise<MeProbeResult> {
  const url = `${getApiBaseUrl()}/me`;
  try {
    const token = await getSessionBearerToken(page);
    const response = await page.request.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      bodyPreview: (await response.text()).slice(0, ME_PROBE_BODY_PREVIEW),
      error: null,
      ok: response.ok(),
      status: response.status(),
      url,
    };
  } catch (error) {
    return {
      bodyPreview: null,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      status: null,
      url,
    };
  }
}

function isButtonVisible(page: Page, name: RegExp) {
  return page
    .getByRole("button", { name })
    .isVisible()
    .catch(() => false);
}

async function waitForAuthenticatedEntry(
  page: Page
): Promise<AuthenticatedEntry> {
  await waitForSignedInSession(page);

  const deadline = Date.now() + AUTHENTICATED_ENTRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname.includes(ONBOARDING_PATH_SEGMENT)) {
      return "onboarding";
    }

    if (await isButtonVisible(page, RE_OPEN_ORGANIZATION_SWITCHER)) {
      return "shell";
    }

    await page.waitForTimeout(AUTHENTICATED_ENTRY_POLL_MS);
  }

  throw new Error(
    `Authenticated app did not render the shell or onboarding (url=${page.url()})`
  );
}

/**
 * Drives the one-step onboarding wizard (create project). The
 * setup project calls PUT /onboarding/complete-wizard first, so this only
 * runs when that flag was lost (e.g. a test deleted the org's last project).
 */
async function completeOnboarding(page: Page) {
  await page.getByLabel(RE_PROJECT_NAME).fill(`E2E Test Project ${Date.now()}`);
  await page.getByRole("button", { name: RE_CREATE_PROJECT }).click();

  await page.waitForURL(`**${MY_TASKS_PATH}**`, { timeout: SHELL_TIMEOUT_MS });
}

function waitForCurrentUserResponse(page: Page, meUrl: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url() === meUrl &&
      response.ok(),
    { timeout: SHELL_TIMEOUT_MS }
  );
}

async function warmCurrentUser(page: Page) {
  const apiOrigin = getApiBaseUrl();
  const meUrl = `${apiOrigin}/me`;
  let currentUserResponse = waitForCurrentUserResponse(page, meUrl);

  await page.goto(MY_TASKS_PATH);
  const entry = await waitForAuthenticatedEntry(page);
  if (entry === "onboarding") {
    currentUserResponse.catch(() => undefined);
    await completeOnboarding(page);
    currentUserResponse = waitForCurrentUserResponse(page, meUrl);
    await page.goto(MY_TASKS_PATH);
  }

  await ensureAuthenticatedShellReady(page);

  try {
    await currentUserResponse;
  } catch (error) {
    throw new Error(await describeWarmFailure(page, apiOrigin, error));
  }
}

async function describeWarmFailure(
  page: Page,
  apiOrigin: string,
  cause: unknown
): Promise<string> {
  const meProbe = await probeAuthenticatedMe(page);
  const claims = await getSessionBearerToken(page)
    .then((token) => decodeSessionClaims(token))
    .catch(() => null);
  return [
    "The app never loaded the current user from the API.",
    `apiOrigin=${apiOrigin}`,
    `appUrl=${page.url()}`,
    `userId=${claims?.sub ?? "null"}`,
    `orgSlug=${claims?.org_slug ?? "null"}`,
    `meProbe=${JSON.stringify(meProbe)}`,
    `cause=${cause instanceof Error ? cause.message : String(cause)}`,
  ].join("\n");
}
