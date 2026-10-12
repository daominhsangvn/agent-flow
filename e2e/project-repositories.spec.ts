import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { createTeam, deleteTeam } from "./helpers/create-team";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to manage project repositories";
const MISSING_CONNECTION_ID = "0199a5f0-0000-7000-8000-00000000ffff";
const NO_REPOSITORIES_RE = /No repositories yet/;
const ADD_FORM_RE = /No connection offers repositories yet|Choose a connection/;
const REPOSITORIES_TAB_RE = /tab=repositories/;
const NO_RUNNERS_RE = /No runners yet/;

test("project repositories: empty state, add form and the admin API", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);
  const api = getApiBaseUrl();
  const headers = { Authorization: `Bearer ${token}` };

  let teamId: string | null = null;
  let projectId: string | null = null;
  try {
    const team = await createTeam(request, {
      name: createUniqueName("e2e-repos-team"),
      token,
    });
    teamId = team.id;
    const project = await createProject(request, {
      name: createUniqueName("e2e-repos-project"),
      teamIds: [team.id],
      token,
    });
    projectId = project.id;

    const list = await request.get(
      `${api}/projects/${project.id}/repositories`,
      { headers }
    );
    expect(list.ok()).toBe(true);
    expect((await list.json()).data).toEqual({ repositories: [] });

    const add = await request.post(
      `${api}/projects/${project.id}/repositories`,
      {
        data: { connectionId: MISSING_CONNECTION_ID, externalId: "1" },
        headers,
      }
    );
    expect(add.status()).toBe(404);

    await page.goto(`/${orgSlug}/teams/${team.id}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Repositories" }).click();
    await expect(page).toHaveURL(REPOSITORIES_TAB_RE);
    await expect(page.getByText(NO_REPOSITORIES_RE)).toBeVisible({
      timeout: 15_000,
    });

    // Runners: none yet, and a computer that does not exist is refused.
    await expect(page.getByText(NO_RUNNERS_RE)).toBeVisible();
    const runners = await request.get(`${api}/projects/${project.id}/runners`, {
      headers,
    });
    expect((await runners.json()).data).toEqual({ runners: [] });
    const unknownRunner = await request.put(
      `${api}/projects/${project.id}/runners`,
      { data: { runnerIds: [MISSING_CONNECTION_ID] }, headers }
    );
    expect(unknownRunner.status()).toBe(400);

    await page.getByRole("button", { name: "Add repository" }).click();
    await expect(page.getByText(ADD_FORM_RE).first()).toBeVisible({
      timeout: 15_000,
    });

    // Agent instructions live on the overview: saved, and still there after
    // a reload. The overview no longer carries project-management fields.
    await page.getByRole("radio", { name: "Overview" }).click();
    await expect(page.getByText("Due Date")).toHaveCount(0);
    const instructions = page.getByRole("textbox", {
      name: "Agent instructions",
    });
    await instructions.fill("- shop: storefront\n- api: backend");
    await page.getByRole("button", { name: "Save instructions" }).click();
    await expect(
      page.getByRole("button", { name: "Save instructions" })
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Agent instructions" })
    ).toHaveValue("- shop: storefront\n- api: backend", { timeout: 15_000 });
    const stored = await request.get(
      `${api}/projects/${project.id}/agent-instructions`,
      { headers }
    );
    expect((await stored.json()).data).toEqual({
      instructions: "- shop: storefront\n- api: backend",
    });
    await page.getByRole("radio", { name: "Repositories" }).click();
    await expect(
      page.getByRole("textbox", { name: "Agent instructions" })
    ).toHaveCount(0);
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
    if (teamId) {
      await deleteTeam(request, teamId, token);
    }
  }
});
