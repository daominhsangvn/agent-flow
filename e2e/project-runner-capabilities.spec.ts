import { randomUUID } from "node:crypto";
import {
  type ComputeTargetCapabilities,
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { requireOrgClaims } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

// Project → Integrations → Commands: what each runner declares in its
// AGENTFLOW.md. A file only exists once a runner uploaded it, so the list is
// served by a route; the project and the page are real.

const CONTENT =
  "---\ncommands:\n  - { name: /plan-ticket, mode: write }\n---\n# Dev runner\n";

test("project runner capabilities: the runners' declared commands", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgSlug } = requireOrgClaims(token);
  let projectId: string | null = null;
  try {
    const project = await createProject(request, {
      name: createUniqueName("e2e-capabilities-project"),
      token,
    });
    projectId = project.id;

    let reads = 0;
    await page.route(
      `**/projects/${project.id}/runner-capabilities`,
      async (route) => {
        reads += 1;
        await route.fulfill({
          json: { success: true, data: [capabilities(project.id)] },
        });
      }
    );

    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await page.getByRole("radio", { name: "Integrations" }).click();
    const section = page.getByTestId("project-runner-capabilities");
    await expect(section).toBeVisible({ timeout: 15_000 });
    // Loaded only once opened.
    expect(reads).toBe(0);

    await section.getByRole("button", { name: "Show" }).click();
    const row = section.getByTestId("runner-capabilities-row");
    await expect(row).toContainText("Dev (LeaveDesk)");
    await expect(row.getByLabel("Commands")).toContainText(
      "/plan-ticket <ticket-key>"
    );
    await expect(row).toContainText("write");
    await expect(row).toContainText("→ plan");
    await expect(row).toContainText("/missing is not in .claude/commands");

    await row.getByRole("button", { name: "View file" }).click();
    await expect(row.locator("pre")).toContainText("# Dev runner");
  } finally {
    if (projectId) {
      await deleteProject(request, projectId, token);
    }
  }
});

function capabilities(projectId: string): ComputeTargetCapabilities {
  return {
    id: randomUUID(),
    computeTargetId: randomUUID(),
    runnerName: "an-PRO-1",
    isOnline: true,
    projectId,
    source: RunnerCapabilitiesSource.Personal,
    content: CONTENT,
    capabilities: {
      runner: "Dev (LeaveDesk)",
      toolkit: null,
      commands: [
        {
          name: "/plan-ticket",
          args: "<ticket-key>",
          mode: RunnerCommandMode.Write,
          produces: "plan",
        },
      ],
      skills: [{ name: "tdd" }],
    },
    problems: [],
    warnings: ["/missing is not in .claude/commands or .claude/skills"],
    contentHash: "0".repeat(64),
    uploadedAt: new Date().toISOString(),
  };
}
