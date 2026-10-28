/**
 * The workflow editor is YAML (packages/app/workflows/components/
 * workflow-editor.tsx): this drives the real CodeMirror editor — the
 * suggestion popup (keys, the built-in HTTP trigger snippet, the project and
 * runner names), the underlined problems — then creates the workflow and
 * edits it again by name.
 */

import type { Locator, Page } from "@playwright/test";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import {
  deleteComputeTarget,
  registerComputeTarget,
} from "./helpers/compute-targets";
import { createProject, deleteProject } from "./helpers/create-project";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { deleteWorkflow } from "./helpers/workflows";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to create workflows";
const WORKFLOW_PAGE_RE = /\/workflows\/[0-9a-f-]{36}$/;
const UI_TIMEOUT_MS = 30_000;
// CodeMirror lets Enter pick an option only once the popup has been open
// for 75 ms (its interactionDelay), so a key pressed before it could be
// seen goes to the text instead.
const POPUP_SETTLE_MS = 150;

test("workflow configuration: write it as YAML with suggestions, create it, edit it", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  test.setTimeout(120_000);
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);
  const api = getApiBaseUrl();
  const headers = { Authorization: `Bearer ${token}` };
  const workflowName = createUniqueName("e2e-yaml-workflow");

  let projectId: string | null = null;
  let runnerId: string | null = null;
  let workflowId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-yaml-project"),
      token,
    });
    projectId = project.id;
    const runner = await registerComputeTarget(request, {
      machineName: createUniqueName("e2e-yaml-runner"),
      token,
    });
    runnerId = runner.id;

    await page.goto(`/${orgSlug}/workflows/new`);
    const yaml = page.getByTestId("workflow-yaml-content");
    const popup = page.locator(".cm-tooltip-autocomplete");
    await expect(yaml).toContainText("name: New workflow", {
      timeout: UI_TIMEOUT_MS,
    });

    // Start over, picking keys, the HTTP trigger snippet and the names.
    await yaml.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type(`name: ${workflowName}\ntrig`);
    await pickSuggestion(page, popup, "triggers");
    // A new item offers one snippet per connection and type; "HTTP" narrows
    // it to the workflow's own endpoint.
    await page.keyboard.type("HTTP");
    await pickSuggestion(page, popup, "HTTP: HTTPS request received");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n");
    await page.keyboard.type("agen");
    await pickSuggestion(page, popup, "agent");
    await page.keyboard.type("project: ");
    await expect(popup).toContainText(project.name);
    await page.keyboard.type(project.name);
    await page.keyboard.press("Escape");
    await page.keyboard.insertText("\n  runner: ");
    await expect(popup).toContainText(runner.machineName);
    await page.keyboard.press("Escape");
    await page.keyboard.insertText(
      `${runner.machineName}\n  mode: ${WorkflowAgentMode.Plan}`
    );
    await expect(yaml).toContainText("connection: http");

    // A wrong name is underlined; removing it clears the problem.
    await page.keyboard.insertText("\n  runAs: nobody@example.invalid");
    await expect(page.locator(".cm-lintRange-error").first()).toBeVisible();
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);

    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page).toHaveURL(WORKFLOW_PAGE_RE, { timeout: UI_TIMEOUT_MS });
    workflowId = page.url().split("/").at(-1) ?? null;

    const created = await request.get(`${api}/workflows/${workflowId}`, {
      headers,
    });
    const workflow = (await created.json()).data;
    expect(workflow).toMatchObject({
      name: workflowName,
      project: { id: project.id },
      agent: { computeTargetId: runner.id, mode: WorkflowAgentMode.Plan },
      triggers: [expect.objectContaining({ builtInHttp: true })],
    });

    // The saved workflow opens as YAML, naming its project and runner.
    const saved = page.getByTestId("workflow-yaml-content");
    await expect(saved).toContainText(`project: ${project.name}`, {
      timeout: UI_TIMEOUT_MS,
    });
    await expect(saved).toContainText(`runner: ${runner.machineName}`);
    await expect(
      page.getByRole("button", { name: "Show URL and secret" })
    ).toBeVisible();
  } finally {
    await deleteWorkflow(request, workflowId, token);
    await deleteComputeTarget(request, runnerId, token);
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
  }
});

/** Enter on the popup's first option once it lists `label`. */
async function pickSuggestion(page: Page, popup: Locator, label: string) {
  await expect(popup.getByRole("option").first()).toContainText(label);
  await page.waitForTimeout(POPUP_SETTLE_MS);
  await page.keyboard.press("Enter");
}
