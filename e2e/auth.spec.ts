import { getE2ECredentials } from "./helpers/better-auth";
import { performSignIn } from "./helpers/sign-in";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const POST_LOGIN_URL = /\/(my-tasks|onboarding)/;
const SIGN_UP_URL = /\/sign-up/;
const RE_INVALID_CREDENTIALS = /invalid email or password/i;
const WRONG_PASSWORD_SUFFIX = "-definitely-wrong";

test.describe("signed out", { tag: E2ETag.Smoke }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in through the form lands on an authenticated page", async ({
    page,
  }) => {
    const { email, password } = getE2ECredentials();

    await performSignIn(page, email, password);

    await expect(page).toHaveURL(POST_LOGIN_URL, { timeout: 30_000 });
    await expect(page.getByLabel("Password", { exact: true })).toBeHidden();
  });

  test("an authenticated route redirects to sign-up", async ({ page }) => {
    await page.goto("/my-tasks");

    await expect(page).toHaveURL(SIGN_UP_URL);
  });

  test("a wrong password shows an error and stays on sign-in", async ({
    page,
  }) => {
    const { email, password } = getE2ECredentials();

    await performSignIn(page, email, `${password}${WRONG_PASSWORD_SUFFIX}`);

    // Next.js renders its own empty role="alert" route announcer.
    await expect(
      page.getByRole("alert").filter({ hasText: RE_INVALID_CREDENTIALS })
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });
});
