import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  createAdoContext,
  createFakeAdo,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  AdoEventAttribute,
  AzureDevOpsTriggerType,
} from "@/lib/integrations/providers/azure-devops/constants";
import {
  workItemAssignedConfigSchema,
  workItemAssignedTrigger,
  workItemTaggedConfigSchema,
  workItemTaggedTrigger,
} from "@/lib/integrations/providers/azure-devops/triggers";
import type {
  InboundEvent,
  InboundEventAttributeValue,
} from "@/lib/integrations/types";

const connection = createAdoContext(createFakeAdo([])).connection;

function event(
  triggerType: string,
  attributes: Record<string, InboundEventAttributeValue> = {}
): InboundEvent {
  return {
    triggerType,
    dedupKey: "4321:rev:7",
    occurredAt: new Date("2026-10-04T11:58:00.000Z"),
    actor: null,
    item: {
      provider: IntegrationProviderKey.AzureDevOps,
      externalId: "4321",
      key: "#4321",
      url: null,
      title: "Export orders as CSV",
      container: "Fabrikam Web",
    },
    attributes: {
      [AdoEventAttribute.Project]: "Fabrikam Web",
      [AdoEventAttribute.WorkItemType]: "User Story",
      [AdoEventAttribute.AreaPath]: "Fabrikam Web\\Checkout\\Payments",
      [AdoEventAttribute.Tags]: ["Checkout", "Backend"],
      [AdoEventAttribute.State]: "New",
      ...attributes,
    },
  };
}

function assignedMatches(config: JsonObject, attributes = {}): boolean {
  return workItemAssignedTrigger.matches(
    event(AzureDevOpsTriggerType.WorkItemAssigned, attributes),
    workItemAssignedConfigSchema.parse(config),
    connection
  );
}

function taggedMatches(config: JsonObject, attributes = {}): boolean {
  return workItemTaggedTrigger.matches(
    event(AzureDevOpsTriggerType.WorkItemTagged, attributes),
    workItemTaggedConfigSchema.parse(config),
    connection
  );
}

describe("azure_devops.work_item_assigned", () => {
  it("matches everything with empty filters", () => {
    expect(assignedMatches({})).toBe(true);
  });

  it("filters projects and work item types case-insensitively", () => {
    expect(assignedMatches({ projects: ["fabrikam web"] })).toBe(true);
    expect(assignedMatches({ projects: ["Other"] })).toBe(false);
    expect(assignedMatches({ workItemTypes: ["Bug", "user story"] })).toBe(
      true
    );
    expect(assignedMatches({ workItemTypes: ["Bug"] })).toBe(false);
  });

  it("matches the area path prefix on path boundaries", () => {
    expect(assignedMatches({ areaPathPrefix: "Fabrikam Web\\Checkout" })).toBe(
      true
    );
    expect(assignedMatches({ areaPathPrefix: "fabrikam web/checkout/" })).toBe(
      true
    );
    expect(assignedMatches({ areaPathPrefix: "Fabrikam Web\\Check" })).toBe(
      false
    );
    expect(
      assignedMatches(
        { areaPathPrefix: "Fabrikam Web" },
        { [AdoEventAttribute.AreaPath]: null }
      )
    ).toBe(false);
  });

  it("requires at least one of the configured tags", () => {
    expect(assignedMatches({ tags: ["backend", "frontend"] })).toBe(true);
    expect(assignedMatches({ tags: ["frontend"] })).toBe(false);
  });

  it("drops blank filter entries", () => {
    expect(
      workItemAssignedConfigSchema.parse({ projects: [" Web ", " "] })
    ).toEqual({
      projects: ["Web"],
      workItemTypes: [],
      areaPathPrefix: "",
      tags: [],
    });
  });

  it("offers manual runs by work item id", () => {
    expect(workItemAssignedTrigger.manualRun).toEqual({
      label: "Work item id",
      placeholder: "1234",
    });
  });
});

describe("azure_devops.work_item_tagged", () => {
  it("matches when the configured tag was added", () => {
    expect(
      taggedMatches(
        { tag: "agentflow" },
        { [AdoEventAttribute.AddedTags]: ["AgentFlow"] }
      )
    ).toBe(true);
  });

  it("ignores tags that were already present", () => {
    expect(
      taggedMatches(
        { tag: "Checkout" },
        { [AdoEventAttribute.AddedTags]: ["AgentFlow"] }
      )
    ).toBe(false);
  });

  it("applies the project and type filters", () => {
    const added = { [AdoEventAttribute.AddedTags]: ["AgentFlow"] };
    expect(
      taggedMatches({ tag: "AgentFlow", projects: ["Other"] }, added)
    ).toBe(false);
    expect(
      taggedMatches({ tag: "AgentFlow", workItemTypes: ["User Story"] }, added)
    ).toBe(true);
  });

  it("requires a tag", () => {
    expect(workItemTaggedConfigSchema.safeParse({ tag: " " }).success).toBe(
      false
    );
  });
});
