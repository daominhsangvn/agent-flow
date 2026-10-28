import type { Locator, Page } from "@playwright/test";
import { getApiBaseUrl } from "./helpers/api-url";
import { isOrgAdminRole, requireOrgClaims } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const ADMIN_REQUIRED_MESSAGE =
  "The e2e user must be an org admin to change a project's process";
const PROCESS_TAB_RE = /tab=process/;
const DEFAULT_PROCESS_RE = /AgentFlow \(default\)\./;
const VERSION_ONE_RE = /^Version 1/;
const COMMENT = "# Requirement analysis (BA)";
// CodeMirror lets Enter pick an option only once the popup has been open
// for 75 ms (its interactionDelay), so a key pressed before it could be
// seen goes to the text instead.
const POPUP_SETTLE_MS = 150;

test("project process: default, customize, save a version, reset", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);
  const api = getApiBaseUrl();
  const headers = { Authorization: `Bearer ${token}` };

  let projectId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-process-project"),
      token,
    });
    projectId = project.id;

    // No version: the built-in AgentFlow flow.
    const initial = await request.get(`${api}/projects/${project.id}/process`, {
      headers,
    });
    expect((await initial.json()).data).toEqual({
      current: null,
      invalidVersion: null,
    });

    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Process" }).click();
    await expect(page).toHaveURL(PROCESS_TAB_RE);
    const panel = page.getByTestId("project-process-panel");
    await expect(panel.getByText(DEFAULT_PROCESS_RE)).toBeVisible({
      timeout: 15_000,
    });

    // Customize starts from the default, as YAML only (the form is hidden);
    // the Spec Kit preset needs a toolkit.
    await panel.getByRole("button", { name: "Customize" }).click();
    const editor = page.getByTestId("project-process-editor");
    const yaml = editor.getByTestId("process-yaml-content");
    await expect(yaml).toContainText("type: agentflow.execute", {
      timeout: 30_000,
    });
    await expect(editor.getByRole("tab")).toHaveCount(0);
    await editor.getByRole("button", { name: "Spec Kit" }).click();
    await expect(yaml).toContainText("id: specify");
    await expect(editor.getByTestId("process-issues")).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "Save process" })
    ).toBeDisabled();

    // Back to the default preset, minus nothing: saved as version 1.
    await editor.getByRole("button", { name: "AgentFlow (default)" }).click();
    await editor.getByRole("button", { name: "Save process" }).click();
    await expect(editor).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("process-step-row")).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("project-process-panel").getByText(VERSION_ONE_RE)
    ).toBeVisible();

    const saved = await request.get(`${api}/projects/${project.id}/process`, {
      headers,
    });
    const savedState = (await saved.json()).data;
    expect(savedState.current.version).toBe(1);
    expect(
      savedState.current.definition.steps.map(
        (step: { type: string }) => step.type
      )
    ).toEqual(["agentflow.plan", "agentflow.execute"]);

    // A toolkit must be one of the project's repositories.
    const badToolkit = await request.put(
      `${api}/projects/${project.id}/process`,
      {
        data: {
          process: {
            toolkit: {
              repository: "acme/not-in-project",
              mounts: [".claude/skills"],
              instructions: "",
            },
            steps: [
              {
                type: "agent",
                id: "specify",
                name: "Specify",
                instruction: "/specify",
              },
            ],
          },
        },
        headers,
      }
    );
    expect(badToolkit.status()).toBe(400);

    // Back to the default: a new version without a definition.
    await page
      .getByRole("button", { name: "Use the AgentFlow default" })
      .click();
    await expect(
      page.getByTestId("project-process-panel").getByText(DEFAULT_PROCESS_RE)
    ).toBeVisible({ timeout: 15_000 });
    const versions = await request.get(
      `${api}/projects/${project.id}/process/versions`,
      { headers }
    );
    expect(
      (await versions.json()).data.versions.map(
        (version: { version: number; definition: unknown }) => [
          version.version,
          version.definition === null,
        ]
      )
    ).toEqual([
      [2, true],
      [1, false],
    ]);

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByTestId("process-history")).toBeVisible();
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
  }
});

test("project process: write it as YAML with the suggestion popup, comments kept", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgRole, orgSlug } = requireOrgClaims(token);
  expect(isOrgAdminRole(orgRole), ADMIN_REQUIRED_MESSAGE).toBe(true);
  const api = getApiBaseUrl();
  const headers = { Authorization: `Bearer ${token}` };

  let projectId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-process-yaml-project"),
      token,
    });
    projectId = project.id;

    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Process" }).click();
    const panel = page.getByTestId("project-process-panel");
    await panel.getByRole("button", { name: "Customize" }).click({
      timeout: 15_000,
    });
    const editor = page.getByTestId("project-process-editor");
    const yaml = editor.getByTestId("process-yaml-content");
    const popup = page.locator(".cm-tooltip-autocomplete");
    // The YAML view opens on the default process.
    await expect(yaml).toContainText("type: agentflow.plan", {
      timeout: 30_000,
    });

    // Start over: a comment, then "steps" and an agent step from the popup.
    await yaml.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type(`${COMMENT}\nste`);
    await pickSuggestion(page, popup, "steps");
    // A new item of steps offers the step snippets first.
    await pickSuggestion(page, popup, "Agent step");
    await page.keyboard.type("analyze");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Analyze");
    await page.keyboard.press("Tab");
    // {{ lists the instruction variables.
    await page.keyboard.type("Read {{");
    await expect(popup).toContainText("issue.file");
    await page.keyboard.type("issue.f");
    await pickSuggestion(page, popup, "issue.file");
    await page.keyboard.press("Escape");
    await expect(yaml).toContainText("Read {{issue.file}}");
    await expect(editor.getByTestId("process-issues")).toHaveCount(0);

    // A problem is underlined and blocks the save until it is undone.
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n    questions: ask");
    await expect(page.locator(".cm-lintRange-error").first()).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "Save process" })
    ).toBeDisabled();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);

    await editor.getByRole("button", { name: "Save process" }).click();
    await expect(editor).toHaveCount(0);
    const saved = await request.get(`${api}/projects/${project.id}/process`, {
      headers,
    });
    const definition = (await saved.json()).data.current.definition;
    expect(definition.steps).toEqual([
      expect.objectContaining({
        type: "agent",
        id: "analyze",
        name: "Analyze",
        instruction: "Read {{issue.file}}",
        questions: "continue",
        finish: "none",
      }),
    ]);
    expect(definition.source).toContain(COMMENT);

    // Editing again shows the saved YAML, comment included.
    await page.reload();
    await page
      .getByTestId("project-process-panel")
      .getByRole("button", { name: "Edit" })
      .click({ timeout: 15_000 });
    await expect(
      page
        .getByTestId("project-process-editor")
        .getByTestId("process-yaml-content")
    ).toContainText(COMMENT, { timeout: 30_000 });
  } finally {
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
