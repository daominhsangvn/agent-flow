/**
 * Local Git (git hosting on the user's own machine): the connection the
 * server provides to every organization (with LOCAL_GIT_TOKEN on the API) or,
 * without it, the connection an admin adds in Settings; and creating a
 * repository from Project → Repositories. CI has no Local Git server, so the
 * second spec stubs the connection, its repository listing and the two
 * writes with route mocks, and asserts what the UI sends.
 */
import type { IntegrationConnection } from "@repo/api/src/types/integration";
import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to manage connections and repositories";
const LOCAL_GIT_RE = /Local Git/;
const REPOSITORIES_TAB_RE = /tab=repositories/;
const CONNECTION_ID = "0199a5f0-0000-7000-8000-00000000a11c";
const NOW = "2026-10-09T00:00:00.000Z";

test("Local Git connection: provided by the server, else offered in Add connection", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

  const catalog = await request.get(
    `${getApiBaseUrl()}/integrations/providers`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const providers: Array<{
    key: string;
    capabilities: string[];
    providedByServer: boolean;
  }> = (await catalog.json()).data.providers;
  const localGit = providers.find((provider) => provider.key === "local_git");
  expect(localGit).toMatchObject({
    capabilities: expect.arrayContaining([
      "repositories",
      "repository_creation",
      "actions",
    ]),
  });

  await page.goto(`/${orgSlug}/settings?tab=integrations`);
  if (localGit?.providedByServer) {
    // Every organization already has it: listed as Default, never added.
    const row = page
      .getByRole("list", { name: "Integration connections" })
      .getByRole("listitem")
      .filter({ hasText: "Provided by the server" });
    await expect(row).toContainText("Local Git", { timeout: 30_000 });
    await expect(row).toContainText("Default");
    await expect(
      page.getByRole("button", { name: "Delete Local Git" })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Add connection" }).first().click();
    const picker = page.getByRole("dialog");
    await expect(
      picker.getByRole("button", { name: LOCAL_GIT_RE })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    return;
  }

  // Without LOCAL_GIT_TOKEN on the API an admin adds it: settings in YAML,
  // the token in its password field.
  await page.getByRole("button", { name: "Add connection" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: LOCAL_GIT_RE }).click();
  const yaml = dialog.getByTestId("connection-yaml-content");
  await expect(yaml).toContainText("serverUrl: http://localhost:3300", {
    timeout: 30_000,
  });
  await expect(yaml).toContainText("runnerUrl:");
  await expect(yaml).toContainText("owner:");
  await expect(dialog.getByLabel("Access token")).toHaveAttribute(
    "type",
    "password"
  );

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("project repositories: create a repository in Local Git and add it", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

  let projectId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-local-git-project"),
      token,
    });
    projectId = project.id;

    const created = {
      externalId: "12",
      fullName: "contoso/notes",
      name: "notes",
      namespace: "contoso",
      defaultBranch: "main",
      webUrl: "http://localhost:3300/contoso/notes",
      isPrivate: true,
    };
    const createBodies: unknown[] = [];
    const addBodies: unknown[] = [];
    let added = false;

    await page.route("**/integrations/connections", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              success: true,
              data: { connections: [localGitConnection()] },
            },
          })
        : route.continue()
    );
    await page.route(
      `**/integrations/connections/${CONNECTION_ID}/repositories*`,
      (route) => {
        if (route.request().method() === "POST") {
          createBodies.push(route.request().postDataJSON());
          return route.fulfill({ json: { success: true, data: created } });
        }
        return route.fulfill({
          json: { success: true, data: { repositories: [] } },
        });
      }
    );
    await page.route(`**/projects/${project.id}/repositories`, (route) => {
      if (route.request().method() === "POST") {
        addBodies.push(route.request().postDataJSON());
        added = true;
        return route.fulfill({
          json: { success: true, data: projectRepository(project.id) },
        });
      }
      return route.fulfill({
        json: {
          success: true,
          data: { repositories: added ? [projectRepository(project.id)] : [] },
        },
      });
    });

    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Integrations" }).click();
    await expect(page).toHaveURL(REPOSITORIES_TAB_RE);
    await page.getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("combobox", { name: "Connection" }).click();
    await page.getByRole("option", { name: LOCAL_GIT_RE }).click();

    const form = page.getByTestId("create-repository-form");
    await expect(form).toBeVisible({ timeout: 15_000 });
    await form
      .getByRole("textbox", { name: "New repository name" })
      .fill("notes");
    await form.getByRole("button", { name: "Create and add" }).click();

    await expect(page.getByTestId("project-repository-row")).toContainText(
      "contoso/notes",
      { timeout: 15_000 }
    );
    expect(createBodies).toEqual([{ name: "notes" }]);
    expect(addBodies).toEqual([
      { connectionId: CONNECTION_ID, externalId: "12" },
    ]);
    await expect(
      page.getByRole("link", { name: "contoso/notes" })
    ).toHaveAttribute("href", "http://localhost:3300/contoso/notes");
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
  }
});

function localGitConnection(): IntegrationConnection {
  return {
    id: CONNECTION_ID,
    managedByWorkflowId: null,
    providedByServer: true,
    provider: "local_git",
    name: "Local Git",
    status: "active",
    config: {
      serverUrl: "http://localhost:3300",
      runnerUrl: "http://host.docker.internal:3300",
      owner: "contoso",
    },
    secretFields: { token: { isSet: true, lastFour: "f00d" } },
    account: { externalAccountId: "3", displayName: "agentflow" },
    deliveryMode: "none",
    pollIntervalSeconds: 120,
    inboundUrl: null,
    lastPolledAt: null,
    lastDeliveryAt: null,
    lastValidatedAt: null,
    lastError: null,
    usageCount: 0,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function projectRepository(projectId: string) {
  return {
    id: "0199a5f0-0000-7000-8000-00000000a12d",
    projectId,
    connectionId: CONNECTION_ID,
    connectionName: "Local Git",
    provider: "local_git",
    externalId: "12",
    fullName: "contoso/notes",
    name: "notes",
    defaultBranch: "main",
    webUrl: "http://localhost:3300/contoso/notes",
    isPrimary: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
