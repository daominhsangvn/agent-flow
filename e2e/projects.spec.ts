import { gotoAuthenticatedApp } from "./helpers/app-bootstrap";
import { deleteProject } from "./helpers/create-project";
import { deleteTeam } from "./helpers/create-team";
import {
  createProjectViaDialog,
  createTeamViaSidebar,
} from "./helpers/dialog-flows";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_TEAM_URL = /\/teams\/([^/?#]+)/;
const RE_PROJECT_URL = /\/teams\/[^/?#]+\/projects\/([^/?#]+)/;

test("create a team then a project and land on project detail", {
  tag: E2ETag.Smoke,
}, async ({ apiToken, page, request }) => {
  const teamName = createUniqueName("e2e-team");
  const projectName = createUniqueName("e2e-project");

  await gotoAuthenticatedApp(page);

  let teamId: string | null = null;
  let projectId: string | null = null;
  try {
    // Step 1: Create a team
    await createTeamViaSidebar(page, teamName);
    await page.waitForURL(RE_TEAM_URL, { timeout: 30_000 });
    teamId = RE_TEAM_URL.exec(new URL(page.url()).pathname)?.[1] ?? null;

    // Step 2: Create a project (should now be on /teams/{id}/projects)
    const projectDialog = await createProjectViaDialog(page, projectName);
    await expect(projectDialog).not.toBeVisible({ timeout: 15_000 });

    // Should land on project detail page
    await page.waitForURL(RE_PROJECT_URL, { timeout: 30_000 });
    projectId = RE_PROJECT_URL.exec(new URL(page.url()).pathname)?.[1] ?? null;
    await expect(page.getByText(projectName).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, apiToken);
    }
    if (teamId) {
      await deleteTeam(request, teamId, apiToken);
    }
  }
});
