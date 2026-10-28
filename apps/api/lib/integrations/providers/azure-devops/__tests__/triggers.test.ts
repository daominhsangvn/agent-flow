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
  workItemConditionsConfigSchema,
  workItemConditionsTrigger,
  workItemTaggedConfigSchema,
  workItemTaggedTrigger,
} from "@/lib/integrations/providers/azure-devops/triggers";
import { TriggerConditionMatch } from "@/lib/integrations/trigger-conditions";
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

describe("azure_devops.work_item_conditions", () => {
  function conditionsMatch(
    config: JsonObject,
    attributes: Record<string, InboundEventAttributeValue>
  ): boolean {
    return workItemConditionsTrigger.matches(
      event(AzureDevOpsTriggerType.WorkItemConditions, {
        [AdoEventAttribute.AssignedToBot]: false,
        [AdoEventAttribute.BecameAssigned]: false,
        [AdoEventAttribute.AddedTags]: [],
        [AdoEventAttribute.Mentioned]: false,
        ...attributes,
      }),
      workItemConditionsConfigSchema.parse(config),
      connection
    );
  }

  const assignedUntagged = {
    [AdoEventAttribute.AssignedToBot]: true,
    [AdoEventAttribute.BecameAssigned]: true,
    [AdoEventAttribute.Tags]: ["Checkout"],
  };
  const taggedWhileAssigned = {
    [AdoEventAttribute.AssignedToBot]: true,
    [AdoEventAttribute.Tags]: ["Checkout", "AgentFlow"],
    [AdoEventAttribute.AddedTags]: ["AgentFlow"],
  };
  const taggedUnassigned = {
    [AdoEventAttribute.Tags]: ["Checkout", "AgentFlow"],
    [AdoEventAttribute.AddedTags]: ["AgentFlow"],
  };

  it("requires at least one condition", () => {
    expect(workItemConditionsConfigSchema.safeParse({}).success).toBe(false);
    expect(
      workItemConditionsConfigSchema.safeParse({ states: ["New"] }).success
    ).toBe(false);
    expect(workItemConditionsConfigSchema.parse({ mentioned: true })).toEqual({
      match: TriggerConditionMatch.All,
      assigned: false,
      tags: [],
      mentioned: true,
      projects: [],
      workItemTypes: [],
      areaPathPrefix: "",
      states: [],
    });
  });

  it("starts on the second of assigned + tagged, in either order (all)", () => {
    const config = { assigned: true, tags: ["agentflow"] };
    expect(conditionsMatch(config, assignedUntagged)).toBe(false);
    expect(conditionsMatch(config, taggedUnassigned)).toBe(false);
    expect(conditionsMatch(config, taggedWhileAssigned)).toBe(true);
    expect(
      conditionsMatch(config, {
        ...assignedUntagged,
        [AdoEventAttribute.Tags]: ["AgentFlow"],
      })
    ).toBe(true);
  });

  it("starts on any condition with any", () => {
    const config = {
      match: TriggerConditionMatch.Any,
      assigned: true,
      tags: ["agentflow"],
    };
    expect(conditionsMatch(config, assignedUntagged)).toBe(true);
    expect(conditionsMatch(config, taggedUnassigned)).toBe(true);
    expect(conditionsMatch(config, {})).toBe(false);
  });

  it("combines a mention with the work item's state", () => {
    const config = { mentioned: true, tags: ["agentflow"] };
    const mention = { [AdoEventAttribute.Mentioned]: true };
    expect(
      conditionsMatch(config, {
        ...mention,
        [AdoEventAttribute.Tags]: ["AgentFlow"],
      })
    ).toBe(true);
    expect(conditionsMatch(config, mention)).toBe(false);
  });

  it("applies the project, type, area path and state filters", () => {
    const config = { assigned: true };
    expect(
      conditionsMatch({ ...config, states: ["new"] }, assignedUntagged)
    ).toBe(true);
    expect(
      conditionsMatch({ ...config, states: ["Active"] }, assignedUntagged)
    ).toBe(false);
    expect(
      conditionsMatch(
        { ...config, areaPathPrefix: "Fabrikam Web\\Checkout" },
        assignedUntagged
      )
    ).toBe(true);
    expect(
      conditionsMatch({ ...config, projects: ["Other"] }, assignedUntagged)
    ).toBe(false);
    expect(
      conditionsMatch({ ...config, workItemTypes: ["Bug"] }, assignedUntagged)
    ).toBe(false);
  });
});
