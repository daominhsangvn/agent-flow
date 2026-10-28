import { YamlCompletionKind } from "@repo/app/shared/lib/yaml-completion";
import { describe, expect, it } from "vitest";
import {
  jiraProvider,
  teamsProvider,
} from "../../__tests__/integration-fixtures";
import type { ConnectionYamlContext } from "../connection-yaml";
import { connectionYamlCompletions } from "../connection-yaml-completions";

const NEW_JIRA: ConnectionYamlContext = {
  provider: jiraProvider,
  isEdit: false,
};

/** The suggestions at the "§" of the text (YAML uses "|" itself). */
function at(textWithCursor: string, context = NEW_JIRA) {
  const pos = textWithCursor.indexOf("§");
  const text = textWithCursor.replace("§", "");
  return connectionYamlCompletions(text, pos, context);
}

function labels(textWithCursor: string, context = NEW_JIRA): string[] {
  return (at(textWithCursor, context)?.options ?? []).map(
    (option) => option.label
  );
}

describe("connectionYamlCompletions", () => {
  it("suggests the top-level keys not written yet; enabled only when editing", () => {
    expect(labels("name: Jira\n§")).toEqual(["config", "inbound"]);
    expect(
      labels("name: Jira\n§", { provider: jiraProvider, isEdit: true })
    ).toEqual(["enabled", "config", "inbound"]);
  });

  it("suggests the provider's settings with their labels, never its secrets", () => {
    const result = at("config:\n  deployment: cloud\n  §");

    expect(result?.options.map((option) => option.label)).toEqual([
      "siteUrl",
      "email",
    ]);
    expect(result?.options[0]).toMatchObject({
      kind: YamlCompletionKind.Key,
      detail: "Site URL (required)",
      insert: "siteUrl: ",
    });
  });

  it("suggests a setting's options, filtered by what is typed", () => {
    expect(labels("config:\n  deployment: §")).toEqual([
      "cloud",
      "data_center",
    ]);
    expect(labels("config:\n  deployment: dat§")).toEqual(["data_center"]);
  });

  it("suggests the provider's inbound modes and the poll interval", () => {
    expect(labels("inbound:\n  mode: §")).toEqual(["webhook", "poll", "none"]);
    expect(
      labels("inbound:\n  mode: §", { provider: teamsProvider, isEdit: false })
    ).toEqual(["none"]);
    expect(labels("inbound:\n  §")).toEqual(["mode", "pollIntervalSeconds"]);
    expect(labels("inbound:\n  pollIntervalSeconds: §")).toEqual(["120"]);
  });

  it("suggests true and false for enabled", () => {
    expect(
      labels("enabled: §", { provider: jiraProvider, isEdit: true })
    ).toEqual(["true", "false"]);
  });
});
