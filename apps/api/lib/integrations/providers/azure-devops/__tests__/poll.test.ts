import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  BOT,
  createAdoContext,
  createFakeAdo,
  type FakeRoute,
  HUMAN,
  identityRef,
  revisedBy,
  TEST_ORG_URL,
  TEST_PROJECT,
  TEST_WORK_ITEM_ID,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import { ADO_TOKEN_REJECTED_MESSAGE } from "@/lib/integrations/providers/azure-devops/client";
import {
  AdoEventAttribute,
  AdoField,
  AzureDevOpsTriggerType,
} from "@/lib/integrations/providers/azure-devops/constants";
import {
  ADO_POLL_MAX_ITEMS,
  buildChangedWorkItemsQuery,
  pollAzureDevOps,
} from "@/lib/integrations/providers/azure-devops/poll";
import { HttpMethod } from "@/lib/integrations/types";

const WIQL_PATH = "/contoso/_apis/wit/wiql";
const BATCH_PATH = "/contoso/_apis/wit/workitems";
const updatesPath = (id: number) =>
  `/contoso/_apis/wit/workItems/${id}/updates`;
const ANY_UPDATES_PATH_RE = /\/updates$/;

describe("pollAzureDevOps", () => {
  it("emits assignment and tag events from recent updates on the first poll", async () => {
    const fake = createFakeAdo(standardRoutes());

    const result = await pollAzureDevOps(createAdoContext(fake), null);

    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [AzureDevOpsTriggerType.WorkItemAssigned, `${TEST_WORK_ITEM_ID}:rev:7`],
      [AzureDevOpsTriggerType.WorkItemTagged, `${TEST_WORK_ITEM_ID}:tags:7`],
    ]);
    const [assigned] = result.events;
    expect(assigned?.actor).toEqual({
      id: HUMAN.id,
      displayName: HUMAN.displayName,
    });
    expect(assigned?.occurredAt).toEqual(new Date("2026-10-04T11:58:00.000Z"));
    expect(assigned?.item).toEqual({
      provider: IntegrationProviderKey.AzureDevOps,
      externalId: String(TEST_WORK_ITEM_ID),
      key: `#${TEST_WORK_ITEM_ID}`,
      url: `${TEST_ORG_URL}/Fabrikam%20Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
      title: "Export orders as CSV",
      container: TEST_PROJECT,
    });
    expect(assigned?.attributes[AdoEventAttribute.WorkItemType]).toBe(
      "User Story"
    );
    expect(result.events[1]?.attributes[AdoEventAttribute.AddedTags]).toEqual([
      "AgentFlow",
    ]);
  });

  it("queries WIQL for items assigned to @Me changed since five minutes ago minus the overlap", async () => {
    const fake = createFakeAdo(standardRoutes());

    await pollAzureDevOps(createAdoContext(fake), null);

    const [wiql] = fake.requestsTo(HttpMethod.Post, WIQL_PATH);
    expect(wiql?.url.searchParams.get("timePrecision")).toBe("true");
    expect(wiql?.url.searchParams.get("$top")).toBe(String(ADO_POLL_MAX_ITEMS));
    expect(wiql?.url.searchParams.get("api-version")).toBe("7.1");
    expect(wiql?.url.search).toContain("$top=");
    expect(JSON.parse(wiql?.body ?? "{}")).toEqual({
      query: buildChangedWorkItemsQuery(new Date("2026-10-04T11:53:00.000Z")),
    });
    expect(
      buildChangedWorkItemsQuery(new Date("2026-10-04T11:53:00.000Z"))
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= '2026-10-04T11:53:00.000Z' ORDER BY [System.ChangedDate] ASC"
    );
  });

  it("loads the candidates in one batch without failing on deleted items", async () => {
    const fake = createFakeAdo(standardRoutes());

    await pollAzureDevOps(createAdoContext(fake), null);

    const [batch] = fake.requestsTo(HttpMethod.Get, BATCH_PATH);
    expect(batch?.url.searchParams.get("ids")).toBe(
      `${TEST_WORK_ITEM_ID},4400`
    );
    expect(batch?.url.searchParams.get("errorPolicy")).toBe("omit");
    expect(fake.requestsTo(HttpMethod.Get, updatesPath(4400))).toHaveLength(0);
  });

  it("advances the cursor to the latest change, at least now minus one minute", async () => {
    const fake = createFakeAdo(standardRoutes());

    const result = await pollAzureDevOps(createAdoContext(fake), null);

    expect(result.cursor).toEqual({ since: "2026-10-04T11:59:30.000Z" });

    const quiet = createFakeAdo([
      { method: HttpMethod.Post, path: WIQL_PATH, json: { workItems: [] } },
    ]);
    const next = await pollAzureDevOps(createAdoContext(quiet), {
      since: "2026-10-04T11:30:00.000Z",
    });
    expect(next).toEqual({
      events: [],
      cursor: { since: "2026-10-04T11:59:00.000Z" },
    });
    const [wiql] = quiet.requestsTo(HttpMethod.Post, WIQL_PATH);
    expect(wiql?.body).toContain("'2026-10-04T11:28:00.000Z'");
  });

  it("only advances to the latest change seen when the result is capped", async () => {
    const ids = Array.from(
      { length: ADO_POLL_MAX_ITEMS },
      (_, index) => 1000 + index
    );
    const fake = createFakeAdo([
      {
        method: HttpMethod.Post,
        path: WIQL_PATH,
        json: { workItems: ids.map((id) => ({ id })) },
      },
      {
        method: HttpMethod.Get,
        path: BATCH_PATH,
        json: {
          value: ids.map((id) =>
            batchItem(id, 3, {
              [AdoField.ChangedDate]: "2026-10-04T11:56:00.000Z",
            })
          ),
        },
      },
      {
        method: HttpMethod.Get,
        path: ANY_UPDATES_PATH_RE,
        json: { value: [] },
      },
    ]);

    const result = await pollAzureDevOps(createAdoContext(fake), {
      since: "2026-10-04T11:55:00.000Z",
    });

    expect(result.cursor).toEqual({ since: "2026-10-04T11:56:00.000Z" });
  });

  it("drops updates made by the bot and updates outside the window", async () => {
    const fake = createFakeAdo(standardRoutes());

    const result = await pollAzureDevOps(createAdoContext(fake), null);

    expect(result.events.map((event) => event.dedupKey)).not.toContain(
      `${TEST_WORK_ITEM_ID}:rev:2`
    );
    expect(result.events.map((event) => event.dedupKey)).not.toContain(
      `${TEST_WORK_ITEM_ID}:rev:9`
    );
  });

  it("starts reading updates near the current revision and follows full pages", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      fieldUpdate(251 + index, "2026-10-04T10:00:00.000Z", {})
    );
    const secondPage = [
      fieldUpdate(452, "2026-10-04T11:58:00.000Z", {
        [AdoField.AssignedTo]: { newValue: identityRef(BOT) },
      }),
    ];
    const fake = createFakeAdo([
      {
        method: HttpMethod.Post,
        path: WIQL_PATH,
        json: { workItems: [{ id: TEST_WORK_ITEM_ID }] },
      },
      {
        method: HttpMethod.Get,
        path: BATCH_PATH,
        json: { value: [batchItem(TEST_WORK_ITEM_ID, 452)] },
      },
      {
        method: HttpMethod.Get,
        path: updatesPath(TEST_WORK_ITEM_ID),
        query: { $skip: "252", $top: "200" },
        json: { value: firstPage },
      },
      {
        method: HttpMethod.Get,
        path: updatesPath(TEST_WORK_ITEM_ID),
        query: { $skip: "452", $top: "200" },
        json: { value: secondPage },
      },
    ]);

    const result = await pollAzureDevOps(createAdoContext(fake), null);

    const skips = fake
      .requestsTo(HttpMethod.Get, updatesPath(TEST_WORK_ITEM_ID))
      .map((request) => request.url.searchParams.get("$skip"));
    expect(skips).toEqual(["252", "452"]);
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      `${TEST_WORK_ITEM_ID}:rev:452`,
    ]);
  });

  it("skips items deleted between the query and the history read", async () => {
    const routes = standardRoutes().filter(
      (route) => route.path !== updatesPath(TEST_WORK_ITEM_ID)
    );
    routes.push({
      method: HttpMethod.Get,
      path: updatesPath(TEST_WORK_ITEM_ID),
      status: 404,
      json: { message: "TF401232: Work item 4321 does not exist." },
    });
    const fake = createFakeAdo(routes);

    const result = await pollAzureDevOps(createAdoContext(fake), null);

    expect(result.events).toEqual([]);
  });

  it("fails the poll when the token is rejected", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Post, path: WIQL_PATH, status: 401, json: {} },
    ]);

    await expect(pollAzureDevOps(createAdoContext(fake), null)).rejects.toThrow(
      ADO_TOKEN_REJECTED_MESSAGE
    );
  });

  it("fails the poll when the update history cannot be read", async () => {
    const routes = standardRoutes().filter(
      (route) => route.path !== updatesPath(TEST_WORK_ITEM_ID)
    );
    routes.push({
      method: HttpMethod.Get,
      path: updatesPath(TEST_WORK_ITEM_ID),
      status: 503,
      json: {},
    });
    const fake = createFakeAdo(routes);

    await expect(pollAzureDevOps(createAdoContext(fake), null)).rejects.toThrow(
      "HTTP 503"
    );
  });

  it("requires a verified bot account", async () => {
    const fake = createFakeAdo([]);

    await expect(
      pollAzureDevOps(createAdoContext(fake, { account: null }), null)
    ).rejects.toThrow("no verified Azure DevOps account");
    expect(fake.requests).toHaveLength(0);
  });
});

function standardRoutes(): FakeRoute[] {
  return [
    {
      method: HttpMethod.Post,
      path: WIQL_PATH,
      json: {
        queryType: "flat",
        asOf: "2026-10-04T12:00:00.000Z",
        workItems: [
          {
            id: TEST_WORK_ITEM_ID,
            url: `${TEST_ORG_URL}/_apis/wit/workItems/${TEST_WORK_ITEM_ID}`,
          },
          { id: 4400, url: `${TEST_ORG_URL}/_apis/wit/workItems/4400` },
        ],
      },
    },
    {
      method: HttpMethod.Get,
      path: BATCH_PATH,
      // 4400 was deleted after the query: errorPolicy=omit returns null.
      json: { count: 2, value: [batchItem(TEST_WORK_ITEM_ID, 9), null] },
    },
    {
      method: HttpMethod.Get,
      path: updatesPath(TEST_WORK_ITEM_ID),
      json: { count: 5, value: historyOfTestItem() },
    },
  ];
}

function batchItem(
  id: number,
  rev: number,
  fields: JsonObject = {}
): JsonObject {
  return {
    id,
    rev,
    fields: {
      [AdoField.Title]: "Export orders as CSV",
      [AdoField.TeamProject]: TEST_PROJECT,
      [AdoField.WorkItemType]: "User Story",
      [AdoField.AreaPath]: "Fabrikam Web\\Checkout",
      [AdoField.State]: "Active",
      [AdoField.Tags]: "Checkout; AgentFlow",
      [AdoField.ChangedDate]: "2026-10-04T11:59:30.000Z",
      ...fields,
    },
    url: `${TEST_ORG_URL}/_apis/wit/workItems/${id}`,
  };
}

/** Updates of the test item: an old assignment, the new one, a link-only update and the bot's comment. */
function historyOfTestItem(): JsonObject[] {
  return [
    fieldUpdate(1, "2026-09-01T09:00:00.000Z", {
      [AdoField.Title]: { newValue: "Export orders as CSV" },
    }),
    fieldUpdate(2, "2026-09-01T09:05:00.000Z", {
      [AdoField.AssignedTo]: { newValue: identityRef(BOT) },
    }),
    fieldUpdate(7, "2026-10-04T11:58:00.000Z", {
      [AdoField.AssignedTo]: {
        oldValue: identityRef(HUMAN),
        newValue: identityRef(BOT),
      },
      [AdoField.Tags]: {
        oldValue: "Checkout",
        newValue: "Checkout; AgentFlow",
      },
    }),
    {
      id: 8,
      workItemId: TEST_WORK_ITEM_ID,
      rev: 7,
      revisedBy: revisedBy(HUMAN),
      revisedDate: "2026-10-04T11:58:30.000Z",
      relations: {
        added: [
          {
            rel: "System.LinkTypes.Related",
            url: `${TEST_ORG_URL}/_apis/wit/workItems/4000`,
            attributes: { isLocked: false },
          },
        ],
      },
    },
    {
      ...fieldUpdate(9, "2026-10-04T11:59:30.000Z", {
        [AdoField.AssignedTo]: {
          oldValue: identityRef(BOT),
          newValue: identityRef(BOT),
        },
      }),
      revisedBy: revisedBy(BOT),
    },
  ];
}

function fieldUpdate(
  rev: number,
  changedDate: string,
  fields: JsonObject
): JsonObject {
  return {
    id: rev,
    workItemId: TEST_WORK_ITEM_ID,
    rev,
    revisedBy: revisedBy(HUMAN),
    revisedDate: "9999-01-01T00:00:00Z",
    fields: {
      "System.Rev": { oldValue: rev - 1, newValue: rev },
      [AdoField.ChangedDate]: { newValue: changedDate },
      ...fields,
    },
    url: `${TEST_ORG_URL}/_apis/wit/workItems/${TEST_WORK_ITEM_ID}/updates/${rev}`,
  };
}
