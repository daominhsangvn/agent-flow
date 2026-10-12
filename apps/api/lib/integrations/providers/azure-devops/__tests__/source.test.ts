import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  commentsResponse,
  createAdoContext,
  createFakeAdo,
  type FakeRoute,
  restWorkItem,
  SIGN_IN_PAGE_HTML,
  TEST_NOW,
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
  fetchAdoSourceItem,
  resolveAdoManualEvent,
  richTextToMarkdown,
} from "@/lib/integrations/providers/azure-devops/source";
import {
  HttpMethod,
  RetryableSourceError,
  type SourceItemRef,
} from "@/lib/integrations/types";

const WORK_ITEM_PATH = `/contoso/_apis/wit/workitems/${TEST_WORK_ITEM_ID}`;
const COMMENTS_PATH = `/contoso/Fabrikam%20Web/_apis/wit/workItems/${TEST_WORK_ITEM_ID}/comments`;

const ref: SourceItemRef = {
  provider: IntegrationProviderKey.AzureDevOps,
  externalId: String(TEST_WORK_ITEM_ID),
  key: `#${TEST_WORK_ITEM_ID}`,
  url: null,
  title: "Export orders as CSV",
  container: TEST_PROJECT,
};

function routes(
  workItem = restWorkItem(),
  comments: Partial<FakeRoute> = {}
): FakeRoute[] {
  return [
    { method: HttpMethod.Get, path: WORK_ITEM_PATH, json: workItem },
    {
      method: HttpMethod.Get,
      path: COMMENTS_PATH,
      json: commentsResponse(),
      ...comments,
    },
  ];
}

describe("fetchAdoSourceItem", () => {
  it("maps the work item to a markdown source item", async () => {
    const fake = createFakeAdo(routes());

    const item = await fetchAdoSourceItem(createAdoContext(fake), ref);

    expect(item).toEqual({
      provider: IntegrationProviderKey.AzureDevOps,
      externalId: String(TEST_WORK_ITEM_ID),
      key: `#${TEST_WORK_ITEM_ID}`,
      url: `${TEST_ORG_URL}/Fabrikam%20Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
      title: "Export orders as CSV",
      container: TEST_PROJECT,
      bodyMarkdown: expect.stringContaining("**As a** shop manager"),
      itemType: "User Story",
      status: "New",
      priority: "2",
      labels: ["Checkout", "Backend"],
      reporter: "Jamal Hartnett",
      assignee: "AgentFlow Bot",
      sections: [
        {
          title: "Acceptance Criteria",
          markdown: expect.stringContaining("Columns: id, date, total"),
        },
      ],
      comments: [
        {
          author: "Jamal Hartnett",
          createdAt: "2026-10-04T11:42:00.000Z",
          bodyMarkdown: "Talked to **finance**.",
        },
        {
          author: "Jamal Hartnett",
          createdAt: "2026-10-04T11:50:00.000Z",
          bodyMarkdown: "Please keep **totals** in EUR.",
        },
      ],
      attachments: [
        {
          name: "orders-spec.pdf",
          url: "https://dev.azure.com/contoso/_apis/wit/attachments/1b2c3d4e-0000-4000-8000-000000000001",
          mimeType: null,
          size: 2048,
        },
      ],
    });
    expect(item.bodyMarkdown).toContain("CSV with one row per order");
    expect(item.bodyMarkdown).not.toContain("<div>");
  });

  it("expands everything without a fields filter and reads the latest comments", async () => {
    const fake = createFakeAdo(routes());

    await fetchAdoSourceItem(createAdoContext(fake), ref);

    const [workItemRequest] = fake.requestsTo(HttpMethod.Get, WORK_ITEM_PATH);
    expect(workItemRequest?.url.searchParams.get("$expand")).toBe("all");
    expect(workItemRequest?.url.searchParams.get("api-version")).toBe("7.1");
    expect(workItemRequest?.url.searchParams.has("fields")).toBe(false);
    const [commentsRequest] = fake.requestsTo(HttpMethod.Get, COMMENTS_PATH);
    expect(commentsRequest?.url.searchParams.get("api-version")).toBe(
      "7.1-preview.4"
    );
    expect(commentsRequest?.url.searchParams.get("$top")).toBe("20");
    expect(commentsRequest?.url.searchParams.get("order")).toBe("desc");
  });

  it("keeps fields stored as Markdown unchanged", async () => {
    const markdown = "## Goal\n\nExport **orders** as `CSV` (see _spec_).";
    const fake = createFakeAdo(
      routes(
        restWorkItem({
          fields: { [AdoField.Description]: markdown },
          multilineFieldsFormat: { [AdoField.Description]: "Markdown" },
        })
      )
    );

    const item = await fetchAdoSourceItem(createAdoContext(fake), ref);

    expect(item.bodyMarkdown).toBe(markdown);
  });

  it("still returns the item when comments cannot be read", async () => {
    const fake = createFakeAdo(
      routes(restWorkItem(), { status: 500, json: {} })
    );
    const ctx = createAdoContext(fake);

    const item = await fetchAdoSourceItem(ctx, ref);

    expect(item.comments).toEqual([]);
    expect(item.title).toBe("Export orders as CSV");
  });

  it("throws a user-facing error for a missing work item", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: WORK_ITEM_PATH,
        status: 404,
        json: { message: "TF401232" },
      },
    ]);

    await expect(
      fetchAdoSourceItem(createAdoContext(fake), ref)
    ).rejects.toThrow(
      `Azure DevOps work item #${TEST_WORK_ITEM_ID} was not found`
    );
  });

  it("throws the token message when ADO answers 203 with the sign-in page", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: WORK_ITEM_PATH,
        status: 203,
        text: SIGN_IN_PAGE_HTML,
      },
    ]);

    await expect(
      fetchAdoSourceItem(createAdoContext(fake), ref)
    ).rejects.toThrow(ADO_TOKEN_REJECTED_MESSAGE);
  });
});

describe("Azure DevOps source failures", () => {
  const TEMPORARY_FAILURES: [string, FakeRoute, string][] = [
    [
      "rate limited (429)",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, status: 429, json: {} },
      "Azure DevOps is unavailable (HTTP 429)",
    ],
    [
      "unavailable (503)",
      {
        method: HttpMethod.Get,
        path: WORK_ITEM_PATH,
        status: 503,
        json: { message: "Service Unavailable" },
      },
      "Azure DevOps is unavailable (HTTP 503): Service Unavailable",
    ],
    [
      "unreachable (network error)",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, networkError: true },
      "Could not reach Azure DevOps",
    ],
  ];
  const PERMANENT_FAILURES: [string, FakeRoute][] = [
    [
      "not found (404)",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, status: 404, json: {} },
    ],
    [
      "denied (403)",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, status: 403, json: {} },
    ],
    [
      "rejecting the token (401)",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, status: 401, json: {} },
    ],
    [
      "answering with an unexpected body",
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, json: { id: "x" } },
    ],
  ];

  it.each(
    TEMPORARY_FAILURES
  )("fetchItem throws a RetryableSourceError when Azure DevOps is %s", async (_label, route, detail) => {
    const fake = createFakeAdo([route]);

    const error = await fetchAdoSourceItem(createAdoContext(fake), ref).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RetryableSourceError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        `Could not load Azure DevOps work item #${TEST_WORK_ITEM_ID}: ${detail}`
      )
    );
  });

  it.each(
    TEMPORARY_FAILURES
  )("resolveManual throws a RetryableSourceError when Azure DevOps is %s", async (_label, route, detail) => {
    const fake = createFakeAdo([route]);

    const error = await resolveAdoManualEvent(
      createAdoContext(fake),
      String(TEST_WORK_ITEM_ID),
      AzureDevOpsTriggerType.WorkItemAssigned
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RetryableSourceError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        `Could not load Azure DevOps work item #${TEST_WORK_ITEM_ID}: ${detail}`
      )
    );
  });

  it.each(
    PERMANENT_FAILURES
  )("keeps a plain Error when Azure DevOps is %s", async (_label, route) => {
    const fetchError = await fetchAdoSourceItem(
      createAdoContext(createFakeAdo([route])),
      ref
    ).catch((thrown: unknown) => thrown);
    const manualError = await resolveAdoManualEvent(
      createAdoContext(createFakeAdo([route])),
      String(TEST_WORK_ITEM_ID),
      AzureDevOpsTriggerType.WorkItemAssigned
    ).catch((thrown: unknown) => thrown);

    for (const error of [fetchError, manualError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableSourceError);
    }
  });
});

describe("richTextToMarkdown", () => {
  it("converts HTML and keeps plain text or markdown as-is", () => {
    expect(richTextToMarkdown("<p>Hello <b>team</b></p>", null)).toBe(
      "Hello **team**"
    );
    expect(richTextToMarkdown("Use *stars* <here>", null)).toBe(
      "Use *stars* <here>"
    );
    expect(richTextToMarkdown("<p>x</p>", "markdown")).toBe("<p>x</p>");
    expect(richTextToMarkdown(null, "html")).toBe("");
  });
});

describe("resolveAdoManualEvent", () => {
  it.each([
    String(TEST_WORK_ITEM_ID),
    `#${TEST_WORK_ITEM_ID}`,
    `${TEST_ORG_URL}/Fabrikam%20Web/_workitems/edit/${TEST_WORK_ITEM_ID}/`,
    `${TEST_ORG_URL}/web/wi.aspx?pcguid=e4e4e4e4&id=${TEST_WORK_ITEM_ID}`,
  ])("resolves %s", async (input) => {
    const fake = createFakeAdo(routes());

    const event = await resolveAdoManualEvent(
      createAdoContext(fake),
      input,
      AzureDevOpsTriggerType.WorkItemAssigned
    );

    expect(event).toEqual({
      triggerType: AzureDevOpsTriggerType.WorkItemAssigned,
      dedupKey: `${TEST_WORK_ITEM_ID}:manual`,
      occurredAt: TEST_NOW,
      actor: null,
      item: expect.objectContaining({
        externalId: String(TEST_WORK_ITEM_ID),
        key: `#${TEST_WORK_ITEM_ID}`,
        container: TEST_PROJECT,
      }),
      attributes: expect.objectContaining({
        [AdoEventAttribute.Project]: TEST_PROJECT,
        [AdoEventAttribute.WorkItemType]: "User Story",
      }),
    });
    const [request] = fake.requestsTo(HttpMethod.Get, WORK_ITEM_PATH);
    expect(request?.url.searchParams.get("$expand")).toBe("none");
  });

  it("rejects work item URLs of another organization", async () => {
    const fake = createFakeAdo(routes());

    await expect(
      resolveAdoManualEvent(
        createAdoContext(fake),
        `https://dev.azure.com/fabrikam/Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
        AzureDevOpsTriggerType.WorkItemAssigned
      )
    ).rejects.toThrow("does not belong to the connection's organization");
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    "PROJ-12",
    "#",
    "0",
    "https://dev.azure.com/contoso/Web/_boards",
  ])("rejects %s", async (input) => {
    const fake = createFakeAdo(routes());

    await expect(
      resolveAdoManualEvent(
        createAdoContext(fake),
        input,
        AzureDevOpsTriggerType.WorkItemAssigned
      )
    ).rejects.toThrow("work item id");
  });

  it("reports work items the token cannot read", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, status: 404, json: {} },
    ]);

    await expect(
      resolveAdoManualEvent(
        createAdoContext(fake),
        String(TEST_WORK_ITEM_ID),
        AzureDevOpsTriggerType.WorkItemTagged
      )
    ).rejects.toThrow("was not found, or the token cannot read it");
  });
});
