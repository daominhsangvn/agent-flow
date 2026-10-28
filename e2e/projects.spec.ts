import { gotoAuthenticatedApp } from "./helpers/app-bootstrap";
import { deleteProject } from "./helpers/create-project";
import { createProjectViaDialog } from "./helpers/dialog-flows";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_PROJECT_URL = /\/projects\/([^/?#]+)$/;
const RE_PROJECTS_LIST_URL = /\/projects$/;
const RE_LEGACY_TEAM_URL = /\/teams\//;

test("create a project from the projects page and land on project detail", {
  tag: E2ETag.Smoke,
}, async ({ apiToken, page, request }) => {
  const projectName = createUniqueName("e2e-project");

  await gotoAuthenticatedApp(page);

  let projectId: string | null = null;
  try {
    await page.getByRole("link", { name: "All projects" }).first().click();
    await page.waitForURL(RE_PROJECTS_LIST_URL, { timeout: 30_000 });

    const projectDialog = await createProjectViaDialog(page, projectName);
    await expect(projectDialog).not.toBeVisible({ timeout: 15_000 });

    await page.waitForURL(RE_PROJECT_URL, { timeout: 30_000 });
    projectId = RE_PROJECT_URL.exec(new URL(page.url()).pathname)?.[1] ?? null;
    await expect(page.getByText(projectName).first()).toBeVisible({
      timeout: 30_000,
    });

    // Legacy team-scoped project URLs redirect to the org-level route.
    const orgPrefix = new URL(page.url()).pathname.split("/projects/")[0];
    await page.goto(`${orgPrefix}/teams/legacy-team/projects/${projectId}`);
    await page.waitForURL(RE_PROJECT_URL, { timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toMatch(RE_LEGACY_TEAM_URL);
    expect(new URL(page.url()).pathname).toBe(
      `${orgPrefix}/projects/${projectId}`
    );
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, apiToken);
    }
  }
});
