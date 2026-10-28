import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  PROVIDERS,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import { makeWorkflow, TRIGGER_ID } from "../../__tests__/workflow-fixtures";
import {
  getActionLabel,
  getManualRunTriggers,
  getTriggerLabel,
  getTypeProviderKey,
} from "../workflow-catalog";

describe("workflow catalog lookups", () => {
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
