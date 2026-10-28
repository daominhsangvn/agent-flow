/**
 * "Set up AI agents for your team" (apps/app/app/(authenticated)/components/
 * agent-onboarding-card.tsx) asks only for what generating agents needs: a
 * runner that is online. It used to ask to connect GitHub and to install the
 * desktop app. The org's agents, its setup checklist and its runners are
 * stubbed, so the card shows whatever the server under test holds.
 */

import type { Page } from "@playwright/test";
import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin: the card is shown to admins only";
const CARD_TITLE = "Set up AI agents for your team";
const GITHUB_RE = /github/i;
const DESKTOP_RE = /desktop/i;
const UI_TIMEOUT_MS = 30_000;

test("agent setup card asks for a runner, not GitHub or the desktop app", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);
  const api = getApiBaseUrl();

  // No agents yet (the card's reason to show), the setup checklist out of the
  // way (the card stands down while it is up), and no runner.
  await stubApiGet(page, api, "/agent-components", {
    items: [],
    total: 0,
    hasMore: false,
  });
  await stubApiGet(page, api, "/onboarding", {
    wizardCompleted: true,
    checklistDismissed: true,
    checklist: [],
  });
  await stubApiGet(page, api, "/compute-targets", []);

  await page.goto(`/${orgSlug}/my-tasks`);
  const card = page
    .locator("[data-slot=card]")
    .filter({ has: page.getByText(CARD_TITLE, { exact: true }) });
  await expect(card).toBeVisible({ timeout: UI_TIMEOUT_MS });

  await expect(card.getByText(GITHUB_RE)).toHaveCount(0);
  await expect(card.getByText(DESKTOP_RE)).toHaveCount(0);
  await expect(
    card.getByRole("link", { name: "Download and install a runner" })
  ).toHaveAttribute("href", `/${orgSlug}/settings?tab=integrations`);
  await expect(
    card.getByRole("button", { name: "Generate Agents" })
  ).toBeDisabled();
});

/** Answers GETs of the API's `path` (any query) with `data`, in the API's envelope. */
async function stubApiGet(
  page: Page,
  api: string,
  path: string,
  data: unknown
) {
  const target = new URL(`${api}${path}`);
  await page.route(
    (url) => url.origin === target.origin && url.pathname === target.pathname,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { success: true, data } })
        : route.fallback()
  );
}
