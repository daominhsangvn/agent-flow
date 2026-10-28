import {
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  AzureDevOpsActionType,
  AzureDevOpsTriggerType,
} from "@/lib/integrations/providers/azure-devops/constants";
import { azureDevOpsProvider } from "@/lib/integrations/providers/azure-devops/provider";
import { toProviderSummary } from "@/lib/integrations/registry";

describe("azureDevOpsProvider", () => {
  it("is registered under the azure_devops key with webhook and poll delivery", () => {
    expect(azureDevOpsProvider.key).toBe(IntegrationProviderKey.AzureDevOps);
    expect(azureDevOpsProvider.inbound?.deliveryModes).toEqual([
      IntegrationDeliveryMode.Webhook,
      IntegrationDeliveryMode.Poll,
    ]);
    expect(azureDevOpsProvider.inbound?.verify).toBeTypeOf("function");
    expect(azureDevOpsProvider.inbound?.parse).toBeTypeOf("function");
    expect(azureDevOpsProvider.inbound?.poll).toBeTypeOf("function");
    expect(azureDevOpsProvider.source?.resolveManual).toBeTypeOf("function");
  });

  it("declares the organization URL and a secret PAT", () => {
    expect(
      azureDevOpsProvider.connection.fields.map((field) => [
        field.key,
        field.kind,
      ])
    ).toEqual([
      ["organizationUrl", IntegrationFieldKind.Url],
      ["pat", IntegrationFieldKind.Secret],
    ]);
    expect(
      azureDevOpsProvider.connection.fields.find((field) => field.key === "pat")
        ?.description
    ).toContain("Work Items (Read & write)");
  });

  it("requires the PAT again when the organization URL changes", () => {
    expect(azureDevOpsProvider.connection.credentialOriginFields).toEqual([
      "organizationUrl",
    ]);
    expect(
      toProviderSummary(azureDevOpsProvider).credentialOriginFields
    ).toEqual(["organizationUrl"]);
  });

  it("exposes the triggers and actions with provider-prefixed keys", () => {
    expect(azureDevOpsProvider.triggers.map((trigger) => trigger.key)).toEqual([
      AzureDevOpsTriggerType.WorkItemAssigned,
      AzureDevOpsTriggerType.WorkItemTagged,
      AzureDevOpsTriggerType.WorkItemMentioned,
      AzureDevOpsTriggerType.WorkItemConditions,
    ]);
    expect(azureDevOpsProvider.actions.map((action) => action.key)).toEqual([
      AzureDevOpsActionType.AddComment,
      AzureDevOpsActionType.UpdateState,
      AzureDevOpsActionType.UpdateTags,
      AzureDevOpsActionType.AddLink,
      AzureDevOpsActionType.CreatePullRequest,
      AzureDevOpsActionType.RunPipeline,
    ]);
    for (const key of [
      ...azureDevOpsProvider.triggers.map((trigger) => trigger.key),
      ...azureDevOpsProvider.actions.map((action) => action.key),
    ]) {
      expect(key.startsWith(`${IntegrationProviderKey.AzureDevOps}.`)).toBe(
        true
      );
    }
  });

  it("subscribes the actions to sensible default events", () => {
    const [comment, state] = azureDevOpsProvider.actions;
    expect(comment?.defaultEvents).toEqual([
      WorkflowRunEvent.Started,
      WorkflowRunEvent.NeedsInput,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
    expect(state?.defaultEvents).toEqual([WorkflowRunEvent.Succeeded]);
  });

  it("parses connection config and secrets", () => {
    expect(
      azureDevOpsProvider.connection.configSchema.parse({
        organizationUrl: "https://contoso.visualstudio.com/",
      })
    ).toEqual({ organizationUrl: "https://contoso.visualstudio.com" });
    expect(
      azureDevOpsProvider.connection.secretsSchema.safeParse({ pat: "" })
        .success
    ).toBe(false);
  });
});
