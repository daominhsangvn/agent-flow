// SECURITY: This file handles authentication credentials. The storageState output
// (.auth/user.json) contains the Better Auth session cookie, which grants full app
// access until it expires. Never commit .auth/user.json or expose it in public
// artifact stores. See playwright.config.ts for the WARNING comment on test-results/.
import { gotoAuthenticatedApp } from "./helpers/app-bootstrap";
import {
  AUTH_STATE_PATH,
  ensureE2EUser,
  getSessionBearerToken,
  requireOrgClaims,
} from "./helpers/better-auth";
import { ensureWizardCompleted } from "./helpers/onboarding";
import { E2ETag } from "./helpers/tags";
import { test as setup } from "./test";

setup("authenticate", { tag: E2ETag.Smoke }, async ({ page }) => {
  // page.request shares the browser context's cookie jar, so the session
  // cookie set by sign-in (or the first-run sign-up) signs the page in too.
  await ensureE2EUser(page.request);

  const token = await getSessionBearerToken(page);
  requireOrgClaims(token);
  await ensureWizardCompleted(page.request, token);

  await gotoAuthenticatedApp(page);
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
