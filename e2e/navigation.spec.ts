import { ensureAuthenticatedShellReady } from "./helpers/app-bootstrap";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const RE_SESSIONS_URL = /\/sessions(\?|$)/;
const RE_COMPUTE_PICKER = /^(Compute:|Select target)/;

test.describe("navigation", { tag: E2ETag.Smoke }, () => {
  test("my-tasks page loads and shows sidebar", async ({ page }) => {
    await page.goto("/my-tasks");
    await ensureAuthenticatedShellReady(page);
    await expect(page.getByText("My Tasks").first()).toBeVisible();
    await expect(page.getByText("Your Teams")).toBeVisible();
    // Loops run on the project's runners, else the organization's: the
    // sidebar no longer has a per-user compute target picker.
    await expect(
      page.getByRole("button", { name: RE_COMPUTE_PICKER })
    ).toHaveCount(0);
  });

  test("retired loops list forwards to sessions", async ({ page }) => {
    await page.goto("/loops");
    await expect(page).toHaveURL(RE_SESSIONS_URL);
    await ensureAuthenticatedShellReady(page);
  });

  // The notification list itself needs Liveblocks (not ported yet), so only
  // the page shell is asserted here.
  test("inbox page renders without errors", async ({ page }) => {
    await page.goto("/inbox");
    await ensureAuthenticatedShellReady(page);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  });

  test("settings page renders tabs", async ({ page }) => {
    await page.goto("/settings");
    await ensureAuthenticatedShellReady(page);
    await expect(page.getByRole("tab").first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
