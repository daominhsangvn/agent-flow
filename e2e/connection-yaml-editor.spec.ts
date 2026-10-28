/**
 * A connection is configured as YAML (packages/app/integrations/components/
 * integration-connection-dialog.tsx): this drives the real CodeMirror editor
 * of a new Jira connection — the suggestion popup (settings and their
 * options), the underlined problems, a secret written in the YAML — and the
 * problems a save attempt lists, without creating the connection (that
 * would call Jira).
 */

import type { Locator, Page } from "@playwright/test";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to add connections";
const JIRA_RE = /^Jira/;
const UI_TIMEOUT_MS = 30_000;
// CodeMirror lets Enter pick an option only once the popup has been open
// for 75 ms (its interactionDelay).
const POPUP_SETTLE_MS = 150;

test("connection settings: write them as YAML with suggestions and see their problems", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

  await page.goto(`/${orgSlug}/settings?tab=integrations`);
  await page.getByRole("button", { name: "Add connection" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: JIRA_RE }).click();

  const yaml = dialog.getByTestId("connection-yaml-content");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(yaml).toContainText("name: Jira", { timeout: UI_TIMEOUT_MS });
  await expect(yaml).toContainText("deployment: cloud");
  // The template leaves the required settings empty: they are underlined.
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible();

  // Start over, picking the settings from the suggestions.
  await yaml.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("name: E2E Jira\nconf");
  await pickSuggestion(page, popup, "config");
  await page.keyboard.type("dep");
  await pickSuggestion(page, popup, "deployment");
  await expect(popup.getByRole("option")).toHaveText(["cloud", "data_center"]);
  await page.keyboard.type("data");
  await pickSuggestion(page, popup, "data_center");
  // An API token is a secret: never in the YAML.
  await page.keyboard.press("Enter");
  await page.keyboard.type("apiToken: not-here");
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({
    timeout: UI_TIMEOUT_MS,
  });

  await dialog.getByRole("button", { name: "Create connection" }).click();
  const problems = dialog.getByTestId("connection-yaml-problems");
  await expect(problems).toContainText(
    'apiToken is a secret: type it in the "API token" field under the editor'
  );
  await expect(problems).toContainText("Add the setting siteUrl (Site URL)");
  await expect(dialog.getByLabel("API token")).toHaveAttribute(
    "type",
    "password"
  );

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

async function pickSuggestion(page: Page, popup: Locator, label: string) {
  await expect(popup.getByRole("option").first()).toContainText(label);
  await page.waitForTimeout(POPUP_SETTLE_MS);
  await page.keyboard.press("Enter");
}
