import { getApiBaseUrl } from "./helpers/api-url";
import { requireOrgClaims } from "./helpers/better-auth";
import {
  deleteComputeTarget,
  registerComputeTarget,
} from "./helpers/compute-targets";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const STORED_TOKEN_RE = /Stored \(ends in 0000\)/;

test("a computer's model provider: import a Claude settings.json, save, reopen", {
  tag: E2ETag.Smoke,
}, async ({ apiToken: token, page, request }) => {
  const { orgSlug } = requireOrgClaims(token);
  const machineName = createUniqueName("e2e-model-provider");
  const target = await registerComputeTarget(request, { machineName, token });
  try {
    await page.goto(`/${orgSlug}/settings?tab=integrations`);
    const openProvider = page.getByRole("button", {
      name: `Model provider for ${machineName}`,
    });
    await openProvider.click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(`Model provider · ${machineName}`)
    ).toBeVisible();
    await dialog.getByRole("combobox").click();
    await page
      .getByRole("option", {
        name: "Anthropic-compatible API (DeepSeek, a proxy, …)",
      })
      .click();
    await dialog.getByLabel("Import from Claude settings.json (optional)").fill(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-e2e-token-0000",
          ANTHROPIC_MODEL: "deepseek-chat",
          CLAUDE_CODE_EFFORT_LEVEL: "max",
        },
      })
    );
    await dialog.getByRole("button", { name: "Import" }).click();
    await expect(dialog.getByLabel("Base URL")).toHaveValue(
      "https://api.deepseek.com/anthropic"
    );
    await expect(dialog.getByLabel("Default model")).toHaveValue(
      "deepseek-chat"
    );
    await expect(dialog.getByLabel("Variable 1 name")).toHaveValue(
      "CLAUDE_CODE_EFFORT_LEVEL"
    );
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    const stored = await request.get(
      `${getApiBaseUrl()}/compute-targets/${target.id}/model-provider`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect((await stored.json()).data).toEqual({
      mode: "custom",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-chat",
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
      token: { isSet: true, lastFour: "0000" },
    });

    await openProvider.click();
    await expect(
      page.getByRole("dialog").getByPlaceholder(STORED_TOKEN_RE)
    ).toBeVisible();
  } finally {
    await deleteComputeTarget(request, target.id, token);
  }
});
