import {
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { toProviderSummary } from "../../../registry";
import { JiraActionType, JiraTriggerType } from "../constants";
import { jiraProvider } from "../provider";
import { CLOUD_SITE_URL } from "./jira.test-helpers";

describe("jiraProvider", () => {
  it("is registered under the jira key with webhook and poll delivery", () => {
    expect(jiraProvider.key).toBe(IntegrationProviderKey.Jira);
    expect(jiraProvider.inbound?.deliveryModes).toEqual([
      IntegrationDeliveryMode.Webhook,
      IntegrationDeliveryMode.Poll,
    ]);
    expect(jiraProvider.inbound?.verify).toBeTypeOf("function");
    expect(jiraProvider.inbound?.parse).toBeTypeOf("function");
    expect(jiraProvider.inbound?.poll).toBeTypeOf("function");
    expect(jiraProvider.source?.fetchItem).toBeTypeOf("function");
    expect(jiraProvider.source?.resolveManual).toBeTypeOf("function");
  });

  it("exposes its triggers and actions under the provider prefix", () => {
    expect(jiraProvider.triggers.map((trigger) => trigger.key)).toEqual([
      JiraTriggerType.IssueAssigned,
      JiraTriggerType.IssueLabeled,
      JiraTriggerType.IssueMentioned,
    ]);
    expect(jiraProvider.actions.map((action) => action.key)).toEqual([
      JiraActionType.AddComment,
      JiraActionType.TransitionIssue,
    ]);
    for (const key of [
      ...jiraProvider.triggers.map((trigger) => trigger.key),
      ...jiraProvider.actions.map((action) => action.key),
    ]) {
      expect(key.startsWith(`${IntegrationProviderKey.Jira}.`)).toBe(true);
    }
  });

  it("requires the API token again when the site URL or deployment changes", () => {
    const configKeys = jiraProvider.connection.fields
      .filter((field) => field.kind !== IntegrationFieldKind.Secret)
      .map((field) => field.key);

    expect(jiraProvider.connection.credentialOriginFields).toEqual([
      "siteUrl",
      "deployment",
    ]);
    for (const key of jiraProvider.connection.credentialOriginFields ?? []) {
      expect(configKeys).toContain(key);
    }
    expect(toProviderSummary(jiraProvider).credentialOriginFields).toEqual([
      "siteUrl",
      "deployment",
    ]);
  });

  it("parses connection config and secrets through the registered schemas", () => {
    const config = jiraProvider.connection.configSchema.safeParse({
      siteUrl: `${CLOUD_SITE_URL}/`,
      email: "bot@acme.com",
    });
    expect(config.success && config.data.siteUrl).toBe(CLOUD_SITE_URL);
    expect(jiraProvider.connection.secretsSchema.safeParse({}).success).toBe(
      false
    );
  });
});
