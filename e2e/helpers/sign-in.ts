import type { Page } from "@playwright/test";
import { gotoAuthenticatedApp } from "./app-bootstrap";
import {
  ensureE2EUser,
  getSessionBearerToken,
  waitForSignedInSession,
} from "./better-auth";
import { ensureWizardCompleted } from "./onboarding";

const SIGN_IN_PATH = "/sign-in";

/** Signs in through the Better Auth sign-in form (packages/auth/components/sign-in.tsx). */
export async function performSignIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto(SIGN_IN_PATH);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Lands an authenticated page on the app shell. The chromium project already
 * loads the setup project's storage state; `fresh` drops it and signs in again
 * through the API (not the form, which is covered by auth.spec.ts and is
 * rate-limited in production builds).
 */
export async function authenticateToApp(
  page: Page,
  options?: { fresh?: boolean }
) {
  if (options?.fresh) {
    await page.context().clearCookies();
    await ensureE2EUser(page.request);
  }

  // Persist `wizardCompletedAt` server-side BEFORE OnboardingGuard's first
  // /onboarding query runs, so the guard renders children on every
  // navigation instead of redirecting to the wizard.
  await waitForSignedInSession(page);
  const token = await getSessionBearerToken(page);
  await ensureWizardCompleted(page.request, token);

  await gotoAuthenticatedApp(page);
}
