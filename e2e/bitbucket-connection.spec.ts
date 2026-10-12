import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to add connections";
const BITBUCKET_RE = /Bitbucket/;

test("Bitbucket connection: offered in the catalog with its token and workspace fields", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

  const catalog = await request.get(
    `${getApiBaseUrl()}/integrations/providers`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const providers: Array<{ key: string; capabilities: string[] }> = (
    await catalog.json()
  ).data.providers;
  expect(
    providers.find((provider) => provider.key === "bitbucket")
  ).toMatchObject({
    capabilities: expect.arrayContaining(["repositories", "actions"]),
  });

  await page.goto(`/${orgSlug}/settings?tab=integrations`);
  await page.getByRole("button", { name: "Add connection" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: BITBUCKET_RE }).click();

  await expect(dialog.getByLabel("API token")).toBeVisible();
  await expect(dialog.getByLabel("Workspace")).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
