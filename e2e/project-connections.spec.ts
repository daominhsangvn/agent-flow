import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

/**
 * Adding a project connection (Project → Integrations). Regression: a Jira
 * project key typed without Enter is kept when the input loses focus; that
 * used to put a chip above the input on mousedown of "Add connection",
 * pushing the button down so the click never landed and nothing was saved.
 * The organization's connections and the save are answered in the browser:
 * a real Jira connection would need a reachable Jira site.
 */

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to manage project connections";
const INTEGRATIONS_TAB_RE = /tab=repositories/;
const JIRA_PROJECTS_RE = /^Jira projects/;
const CONNECTION_ID = "0199a5f0-0000-7000-8000-00000000c0de";

test("project connections: a project key typed without Enter is saved", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);

  let projectId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-connections-project"),
      token,
    });
    projectId = project.id;

    await page.route("**/integrations/connections", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: { success: true, data: { connections: [jiraConnection()] } },
          })
        : route.fallback()
    );
    const posted: unknown[] = [];
    await page.route(`**/projects/${project.id}/connections`, (route) => {
      if (route.request().method() !== "POST") {
        return route.fallback();
      }
      posted.push(route.request().postDataJSON());
      return route.fulfill({
        json: { success: true, data: { id: CONNECTION_ID } },
      });
    });

    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Integrations" }).click();
    await expect(page).toHaveURL(INTEGRATIONS_TAB_RE);
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByRole("combobox", { name: "Connection" }).click();
    await page.getByRole("option", { name: "E2E Jira" }).click();
    await page.getByLabel(JIRA_PROJECTS_RE).fill("SCRUM");
    // No Enter: the click on the button commits the typed key and submits.
    await page
      .getByRole("button", { name: "Add connection", exact: true })
      .last()
      .click();

    await expect
      .poll(() => posted)
      .toEqual([
        {
          connectionId: CONNECTION_ID,
          key: "e2e-jira",
          name: "E2E Jira",
          settings: { projectKeys: ["SCRUM"] },
          override: null,
        },
      ]);
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
  }
});

/** An organization Jira connection as the API lists it. */
function jiraConnection(): IntegrationConnection {
  const now = new Date();
  return {
    id: CONNECTION_ID,
    provider: IntegrationProviderKey.Jira,
    name: "E2E Jira",
    status: IntegrationConnectionStatus.Active,
    managedByWorkflowId: null,
    providedByServer: false,
    config: {
      deployment: "cloud",
      siteUrl: "https://e2e.atlassian.net",
      email: "bot@e2e.test",
    },
    secretFields: { apiToken: { isSet: true, lastFour: "abcd" } },
    account: null,
    deliveryMode: IntegrationDeliveryMode.None,
    pollIntervalSeconds: 120,
    inboundUrl: null,
    lastPolledAt: null,
    lastDeliveryAt: null,
    lastValidatedAt: now,
    lastError: null,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}
