import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { INBOUND_TOKEN_HEADER } from "@/lib/integrations/inbound-auth";
import {
  BOT,
  createAdoContext,
  createFakeAdo,
  HUMAN,
  identityRef,
  identityString,
  revisedBy,
  snapshotFields,
  TEST_EVENT_ID,
  TEST_ORG_URL,
  TEST_PROJECT,
  TEST_PROJECT_ID,
  TEST_WORK_ITEM_ID,
  workItemCreatedPayload,
  workItemUpdatedPayload,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  AdoEventAttribute,
  AdoField,
  AdoIgnoredReason,
  AdoServiceHookEventType,
  AzureDevOpsTriggerType,
} from "@/lib/integrations/providers/azure-devops/constants";
import {
  adoSetupInstructions,
  parseAdoInbound,
  verifyAdoInbound,
} from "@/lib/integrations/providers/azure-devops/inbound";
import type { InboundRequest } from "@/lib/integrations/types";

const SECRET = "inbound-secret-value";
const INBOUND_URL =
  "https://agentflow.example.com/webhooks/integrations/key123";
const HASHED_DELIVERY_ID_RE = /^sha256:[0-9a-f]{64}$/;

describe("verifyAdoInbound", () => {
  const context = {
    connection: {
      id: "c1",
      provider: IntegrationProviderKey.AzureDevOps,
      name: "ADO",
      config: { organizationUrl: TEST_ORG_URL },
      account: null,
    },
    inboundSecret: SECRET,
  };

  it("accepts the secret in the X-AgentFlow-Token header", () => {
    const request = inboundRequest({}, { [INBOUND_TOKEN_HEADER]: SECRET });
    expect(verifyAdoInbound(request, context)).toEqual({ ok: true });
  });

  it("accepts the secret as the Basic auth password", () => {
    const basic = Buffer.from(`azure-devops:${SECRET}`).toString("base64");
    const request = inboundRequest({}, { authorization: `Basic ${basic}` });
    expect(verifyAdoInbound(request, context)).toEqual({ ok: true });
  });

  it("rejects a wrong or missing token", () => {
    expect(
      verifyAdoInbound(
        inboundRequest({}, { [INBOUND_TOKEN_HEADER]: "nope" }),
        context
      )
    ).toEqual({ ok: false, reason: "token_mismatch" });
    expect(verifyAdoInbound(inboundRequest({}), context)).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });
});

describe("parseAdoInbound workitem.updated", () => {
  it("emits work_item_assigned when Assigned To changes to the bot (IdentityRef)", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: {
          [AdoField.AssignedTo]: {
            oldValue: identityRef(HUMAN),
            newValue: identityRef(BOT),
          },
        },
      })
    );

    expect(result.deliveryId).toBe(TEST_EVENT_ID);
    expect(result.eventType).toBe(AdoServiceHookEventType.WorkItemUpdated);
    expect(result.ignoredReason).toBeUndefined();
    expect(result.events).toEqual([
      {
        triggerType: AzureDevOpsTriggerType.WorkItemAssigned,
        dedupKey: `${TEST_WORK_ITEM_ID}:rev:7`,
        occurredAt: new Date("2026-10-04T11:58:12.345Z"),
        actor: { id: HUMAN.id, displayName: HUMAN.displayName },
        item: {
          provider: IntegrationProviderKey.AzureDevOps,
          externalId: String(TEST_WORK_ITEM_ID),
          key: `#${TEST_WORK_ITEM_ID}`,
          url: `${TEST_ORG_URL}/Fabrikam%20Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
          title: "Export orders as CSV",
          container: TEST_PROJECT,
        },
        attributes: {
          [AdoEventAttribute.Project]: TEST_PROJECT,
          [AdoEventAttribute.WorkItemType]: "User Story",
          [AdoEventAttribute.AreaPath]: "Fabrikam Web\\Checkout",
          [AdoEventAttribute.Tags]: ["Checkout", "Backend"],
          [AdoEventAttribute.State]: "New",
        },
      },
    ]);
  });

  it("recognises a 'Display Name <email>' assignee string", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: {
          [AdoField.AssignedTo]: {
            newValue: `AgentFlow Bot <${BOT.uniqueName.toUpperCase()}>`,
          },
        },
        revisedBy: { name: identityString(HUMAN) },
      })
    );

    expect(result.events.map((event) => event.triggerType)).toEqual([
      AzureDevOpsTriggerType.WorkItemAssigned,
    ]);
    expect(result.events[0]?.actor).toEqual({
      id: HUMAN.uniqueName,
      displayName: HUMAN.displayName,
    });
  });

  it("ignores assignments to someone else", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(HUMAN) } },
      })
    );

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(AdoIgnoredReason.NoRelevantChange);
  });

  it("drops changes made by the bot itself", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(BOT) } },
        revisedBy: revisedBy(BOT),
      })
    );

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(AdoIgnoredReason.CausedByBot);
  });

  it("emits work_item_tagged with only the added tags, next to an assignment", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: {
          [AdoField.AssignedTo]: { newValue: identityRef(BOT) },
          [AdoField.Tags]: {
            oldValue: "Checkout",
            newValue: "checkout; AgentFlow; Backend",
          },
        },
      })
    );

    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [AzureDevOpsTriggerType.WorkItemAssigned, `${TEST_WORK_ITEM_ID}:rev:7`],
      [AzureDevOpsTriggerType.WorkItemTagged, `${TEST_WORK_ITEM_ID}:tags:7`],
    ]);
    expect(result.events[1]?.attributes[AdoEventAttribute.AddedTags]).toEqual([
      "AgentFlow",
      "Backend",
    ]);
  });

  it("uses revision.id when workItemId is missing (resource.id is the update id)", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        workItemId: 0,
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(BOT) } },
      })
    );

    expect(result.events[0]?.item.externalId).toBe(String(TEST_WORK_ITEM_ID));
  });

  it("falls back to the project id from resourceContainers", async () => {
    const { [AdoField.TeamProject]: _project, ...snapshot } = snapshotFields();
    const result = await parse(
      workItemUpdatedPayload({
        snapshot,
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(BOT) } },
      })
    );

    expect(result.events[0]?.item.container).toBe(TEST_PROJECT_ID);
    expect(result.events[0]?.item.url).toBe(
      `${TEST_ORG_URL}/${TEST_PROJECT_ID}/_workitems/edit/${TEST_WORK_ITEM_ID}`
    );
  });

  it("ignores events when the connection has no bot account", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(BOT) } },
      }),
      { account: null }
    );

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(AdoIgnoredReason.BotAccountUnknown);
  });
});

describe("parseAdoInbound workitem.created", () => {
  it("emits assigned and tagged events for an item created assigned to the bot", async () => {
    const result = await parse(
      workItemCreatedPayload({ [AdoField.AssignedTo]: identityString(BOT) })
    );

    expect(result.eventType).toBe(AdoServiceHookEventType.WorkItemCreated);
    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [AzureDevOpsTriggerType.WorkItemAssigned, `${TEST_WORK_ITEM_ID}:rev:1`],
      [AzureDevOpsTriggerType.WorkItemTagged, `${TEST_WORK_ITEM_ID}:tags:1`],
    ]);
    expect(result.events[0]?.actor).toEqual({
      id: HUMAN.uniqueName,
      displayName: HUMAN.displayName,
    });
    expect(result.events[0]?.occurredAt).toEqual(
      new Date("2026-10-04T11:40:00.000Z")
    );
    expect(result.events[1]?.attributes[AdoEventAttribute.AddedTags]).toEqual([
      "Checkout",
      "Backend",
    ]);
  });

  it("drops items created by the bot", async () => {
    const result = await parse(
      workItemCreatedPayload({
        [AdoField.CreatedBy]: identityRef(BOT),
        [AdoField.AssignedTo]: identityRef(BOT),
      })
    );

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(AdoIgnoredReason.CausedByBot);
  });
});

describe("parseAdoInbound envelopes", () => {
  it("acknowledges unsupported events without producing events", async () => {
    const result = await parse(
      workItemUpdatedPayload({ envelope: { eventType: "workitem.deleted" } })
    );

    expect(result).toEqual({
      deliveryId: TEST_EVENT_ID,
      eventType: "workitem.deleted",
      events: [],
      ignoredReason: AdoIgnoredReason.UnsupportedEvent,
    });
  });

  it("derives the delivery id from subscription and notification when the event id is missing", async () => {
    const result = await parse(
      workItemUpdatedPayload({ envelope: { id: null } })
    );

    expect(result.deliveryId).toBe("00ca946b-2fe9-4f2a-ae2f-40d5c48001bc:7");
  });

  it("hashes the body of payloads that are not service hook envelopes", async () => {
    const ctx = createAdoContext(createFakeAdo([]));
    const result = await parseAdoInbound(inboundRequestRaw("not json"), ctx);

    expect(result.deliveryId).toMatch(HASHED_DELIVERY_ID_RE);
    expect(result.eventType).toBeNull();
    expect(result.ignoredReason).toBe(AdoIgnoredReason.InvalidPayload);
  });

  it("falls back to the envelope date when the update has no ChangedDate", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: { [AdoField.AssignedTo]: { newValue: identityRef(BOT) } },
        withoutChangedDate: true,
      })
    );

    expect(result.events[0]?.occurredAt).toEqual(
      new Date("2026-10-04T11:58:13.000Z")
    );
  });
});

describe("parseAdoInbound with unexpected non-essential values", () => {
  it("still emits workitem.updated events", async () => {
    const result = await parse(
      workItemUpdatedPayload({
        fields: {
          [AdoField.AssignedTo]: { newValue: identityRef(BOT) },
          "System.Watermark": 42,
        },
        resource: { id: "12", rev: "7", revisedDate: 0 },
        envelope: {
          notificationId: { value: 7 },
          subscriptionId: 5,
          createdDate: 1_791_000_000_000,
          resourceContainers: { project: TEST_PROJECT_ID },
        },
      })
    );

    expect(result.ignoredReason).toBeUndefined();
    expect(result.deliveryId).toBe(TEST_EVENT_ID);
    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [AzureDevOpsTriggerType.WorkItemAssigned, `${TEST_WORK_ITEM_ID}:rev:7`],
    ]);
    expect(result.events[0]?.occurredAt).toEqual(
      new Date("2026-10-04T11:58:12.345Z")
    );
  });

  it("still emits workitem.created events", async () => {
    const result = await parse(
      workItemCreatedPayload(
        { [AdoField.AssignedTo]: identityRef(BOT) },
        { rev: "1", relations: "none", multilineFieldsFormat: ["html"] }
      )
    );

    expect(result.ignoredReason).toBeUndefined();
    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [AzureDevOpsTriggerType.WorkItemAssigned, `${TEST_WORK_ITEM_ID}:rev:1`],
      [AzureDevOpsTriggerType.WorkItemTagged, `${TEST_WORK_ITEM_ID}:tags:1`],
    ]);
  });

  it("still drops deliveries without a usable work item id", async () => {
    const updated = await parse(
      workItemUpdatedPayload({
        resource: { workItemId: null, revision: "gone" },
      })
    );
    const created = await parse(
      workItemCreatedPayload({}, { id: "not-a-number" })
    );

    expect(updated.ignoredReason).toBe(AdoIgnoredReason.InvalidPayload);
    expect(created.ignoredReason).toBe(AdoIgnoredReason.InvalidPayload);
  });
});

describe("adoSetupInstructions", () => {
  const base = {
    connection: {
      id: "c1",
      provider: IntegrationProviderKey.AzureDevOps,
      name: "ADO",
      config: { organizationUrl: TEST_ORG_URL },
      account: null,
    },
    inboundSecret: SECRET,
    inboundUrl: INBOUND_URL,
  };

  it("explains the service hook setup with the URL and token header", () => {
    const text = adoSetupInstructions({
      ...base,
      deliveryMode: IntegrationDeliveryMode.Webhook,
    });

    expect(text).toContain("Service hooks");
    expect(text).toContain(INBOUND_URL);
    expect(text).toContain(`X-AgentFlow-Token:${SECRET}`);
    expect(text).toContain("Work item created");
    expect(text).toContain("poll");
  });

  it("explains poll mode and its tag limitation", () => {
    const text = adoSetupInstructions({
      ...base,
      deliveryMode: IntegrationDeliveryMode.Poll,
    });

    expect(text).toContain("@Me");
    expect(text).toContain("webhook mode");
    expect(text).not.toContain(SECRET);
  });
});

function parse(payload: unknown, options: { account?: null } = {}) {
  const ctx = createAdoContext(createFakeAdo([]), options);
  return parseAdoInbound(inboundRequestRaw(JSON.stringify(payload)), ctx);
}

function inboundRequest(
  payload: unknown,
  headers: Record<string, string> = {}
): InboundRequest {
  return {
    rawBody: JSON.stringify(payload),
    headers: new Headers(headers),
    url: new URL(INBOUND_URL),
  };
}

function inboundRequestRaw(rawBody: string): InboundRequest {
  return { rawBody, headers: new Headers(), url: new URL(INBOUND_URL) };
}
