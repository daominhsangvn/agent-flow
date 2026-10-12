import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_CONNECTION_ID,
  JIRA_ISSUE_ASSIGNED,
  jiraConnection,
  PROVIDERS,
  TEAMS_POST_MESSAGE,
  teamsConnection,
  WEBHOOK_REQUEST,
  webhookConnection,
} from "../../../integrations/__tests__/integration-fixtures";
import { makeWorkflow, TRIGGER_ID } from "../../__tests__/workflow-fixtures";
import {
  findConnectionProvider,
  getActionConnections,
  getActionLabel,
  getManualRunTriggers,
  getTriggerConnections,
  getTriggerLabel,
  getTypeProviderKey,
} from "../workflow-catalog";

const CONNECTIONS = [jiraConnection, teamsConnection, webhookConnection];

describe("workflow catalog lookups", () => {
  it("offers trigger connections only for providers with triggers", () => {
    expect(
      getTriggerConnections(PROVIDERS, CONNECTIONS).map((c) => c.name)
    ).toEqual(["Acme Jira", "Intake webhook"]);
  });

  it("offers action connections only for providers with actions", () => {
    expect(
      getActionConnections(PROVIDERS, CONNECTIONS).map((c) => c.name)
    ).toEqual(["Acme Jira", "Delivery channel"]);
  });

  it("resolves a connection's provider", () => {
    expect(
      findConnectionProvider(PROVIDERS, CONNECTIONS, JIRA_CONNECTION_ID)?.key
    ).toBe(IntegrationProviderKey.Jira);
    expect(
      findConnectionProvider(PROVIDERS, CONNECTIONS, "missing")
    ).toBeUndefined();
  });

  it("labels trigger and action types, falling back to the raw key", () => {
    expect(getTriggerLabel(PROVIDERS, JIRA_ISSUE_ASSIGNED)).toBe(
      "Issue assigned to the bot"
    );
    expect(getActionLabel(PROVIDERS, TEAMS_POST_MESSAGE)).toBe(
      "Post a message"
    );
    expect(getActionLabel(undefined, JIRA_ADD_COMMENT)).toBe(JIRA_ADD_COMMENT);
  });

  it("derives the provider key from a type key", () => {
    expect(getTypeProviderKey(WEBHOOK_REQUEST)).toBe(
      IntegrationProviderKey.Webhook
    );
    expect(getTypeProviderKey("plain")).toBe("plain");
  });

  it("lists enabled triggers that support a manual run", () => {
    const workflow = makeWorkflow();
    expect(getManualRunTriggers(PROVIDERS, workflow.triggers)).toEqual([
      {
        trigger: workflow.triggers[0],
        displayName: "Issue assigned to the bot",
        manualRun: { label: "Issue key", placeholder: "PROJ-123" },
      },
    ]);
    expect(
      getManualRunTriggers(PROVIDERS, [
        { ...workflow.triggers[0], id: TRIGGER_ID, enabled: false },
      ])
    ).toEqual([]);
  });
});
