import { describe, expect, it, vi } from "vitest";
import {
  itemScopeKey,
  parseProjectSettings,
  projectScopeKeys,
  scopeContainer,
} from "@/lib/integrations/project-connections";
import { azureDevOpsProvider } from "@/lib/integrations/providers/azure-devops/provider";
import { githubProvider } from "@/lib/integrations/providers/github/provider";
import { jiraProvider } from "@/lib/integrations/providers/jira/provider";
import { microsoftTeamsProvider } from "@/lib/integrations/providers/microsoft-teams/provider";

vi.mock("@repo/database", () => ({ withDb: vi.fn(), Prisma: {} }));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: vi.fn(),
}));

const JIRA_SITE = "https://Acme.atlassian.net";
const JIRA_CONFIG = {
  deployment: "cloud",
  siteUrl: JIRA_SITE,
  email: "bot@acme.test",
  cloudId: null,
};

describe("project settings and scopes", () => {
  it("normalizes Jira project keys and claims them on the site", () => {
    const settings = parseProjectSettings(jiraProvider, {
      projectKeys: [" ab ", "AB", "ops_2"],
    });

    expect(settings).toEqual({
      ok: true,
      value: { projectKeys: ["AB", "OPS_2"] },
    });
    expect(
      projectScopeKeys(
        jiraProvider,
        JIRA_CONFIG,
        settings.ok ? settings.value : {}
      )
    ).toEqual([
      "jira:https://acme.atlassian.net:AB",
      "jira:https://acme.atlassian.net:OPS_2",
    ]);
  });

  it("refuses Jira settings without a valid key", () => {
    expect(parseProjectSettings(jiraProvider, { projectKeys: [] }).ok).toBe(
      false
    );
    expect(
      parseProjectSettings(jiraProvider, { projectKeys: ["not a key"] }).ok
    ).toBe(false);
  });

  it("matches Azure DevOps projects without regard to case", () => {
    const settings = parseProjectSettings(azureDevOpsProvider, {
      projects: ["Fabrikam", "fabrikam", "Contoso Web"],
    });
    const config = { organizationUrl: "https://dev.azure.com/Acme" };

    expect(settings.ok ? settings.value : null).toEqual({
      projects: ["Fabrikam", "Contoso Web"],
    });
    expect(
      projectScopeKeys(
        azureDevOpsProvider,
        config,
        settings.ok ? settings.value : {}
      )
    ).toEqual([
      "azure_devops:https://dev.azure.com/acme:fabrikam",
      "azure_devops:https://dev.azure.com/acme:contoso web",
    ]);
    expect(itemScopeKey(azureDevOpsProvider, config, "FABRIKAM")).toBe(
      "azure_devops:https://dev.azure.com/acme:fabrikam"
    );
  });

  it("routes an item to the scope of its container", () => {
    expect(itemScopeKey(jiraProvider, JIRA_CONFIG, "ab")).toBe(
      "jira:https://acme.atlassian.net:AB"
    );
    expect(itemScopeKey(jiraProvider, JIRA_CONFIG, null)).toBeNull();
    expect(scopeContainer("jira:https://acme.atlassian.net:AB")).toBe("AB");
  });

  it("has no settings and no scopes for providers without project settings", () => {
    expect(parseProjectSettings(githubProvider, { anything: true })).toEqual({
      ok: true,
      value: {},
    });
    expect(projectScopeKeys(githubProvider, {}, {})).toEqual([]);
    expect(itemScopeKey(githubProvider, {}, "AB")).toBeNull();
  });

  it("claims Teams channels per bot tenant, from links or ids", () => {
    const config = { tenantId: "11111111-2222-4333-8444-555555555555" };
    const settings = parseProjectSettings(microsoftTeamsProvider, {
      channels: [
        "https://teams.microsoft.com/l/channel/19%3AAbC%40thread.tacv2/General?groupId=g",
        "19:abc@thread.tacv2",
      ],
    });

    expect(settings).toEqual({
      ok: true,
      value: { channels: ["19:abc@thread.tacv2"] },
    });
    expect(
      projectScopeKeys(
        microsoftTeamsProvider,
        config,
        settings.ok ? settings.value : {}
      )
    ).toEqual([`microsoft_teams:${config.tenantId}:19:abc@thread.tacv2`]);
    expect(
      itemScopeKey(microsoftTeamsProvider, config, "19:ABC@thread.tacv2")
    ).toBe(`microsoft_teams:${config.tenantId}:19:abc@thread.tacv2`);
    expect(
      parseProjectSettings(microsoftTeamsProvider, { channels: ["general"] }).ok
    ).toBe(false);
  });
});
