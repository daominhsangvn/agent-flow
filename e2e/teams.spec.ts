import { gotoAuthenticatedApp } from "./helpers/app-bootstrap";
import { deleteTeam } from "./helpers/create-team";
import { createTeamViaSidebar } from "./helpers/dialog-flows";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_TEAM_URL = /\/teams\/([^/?#]+)/;

test("create a team via sidebar and verify it appears", {
  tag: E2ETag.Smoke,
}, async ({ apiToken, page, request }) => {
  const teamName = createUniqueName("e2e-team");

  await gotoAuthenticatedApp(page);

  let teamId: string | null = null;
  try {
    const dialog = await createTeamViaSidebar(page, teamName);

    await page.waitForURL(RE_TEAM_URL, { timeout: 30_000 });
    teamId = RE_TEAM_URL.exec(new URL(page.url()).pathname)?.[1] ?? null;
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    // The team should appear in the sidebar
    await expect(page.getByText(teamName).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    if (teamId) {
      await deleteTeam(request, teamId, apiToken);
    }
  }
});
