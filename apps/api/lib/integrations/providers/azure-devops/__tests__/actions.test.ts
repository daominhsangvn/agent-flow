import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  createActionContext,
  createFakeAdo,
  type FakeRoute,
  preActionRunSnapshot,
  restWorkItem,
  runSnapshot,
  TEST_PAT,
  TEST_WORK_ITEM_ID,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  addCommentAction,
  addCommentConfigSchema,
  updateStateAction,
  updateStateConfigSchema,
} from "@/lib/integrations/providers/azure-devops/actions";
import { ADO_TOKEN_REJECTED_MESSAGE } from "@/lib/integrations/providers/azure-devops/client";
import {
  AdoField,
  JsonPatchOperation,
} from "@/lib/integrations/providers/azure-devops/constants";
import { HttpMethod } from "@/lib/integrations/types";

const COMMENTS_PATH = `/contoso/Fabrikam%20Web/_apis/wit/workItems/${TEST_WORK_ITEM_ID}/comments`;
const WORK_ITEM_PATH = `/contoso/_apis/wit/workitems/${TEST_WORK_ITEM_ID}`;

const commentCreated: FakeRoute = {
  method: HttpMethod.Post,
  path: COMMENTS_PATH,
  json: {
    workItemId: TEST_WORK_ITEM_ID,
    id: 987,
    version: 1,
    format: "markdown",
  },
};

describe("azure_devops.add_comment", () => {
  it("posts the rendered markdown comment on the source work item", async () => {
    const fake = createFakeAdo([commentCreated]);
    const config = addCommentConfigSchema.parse({});
    const run = runSnapshot();

    const result = await addCommentAction.execute(
      createActionContext(fake, config, run)
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "987",
      detail: `Comment added to #${TEST_WORK_ITEM_ID}`,
    });
    const [request] = fake.requestsTo(HttpMethod.Post, COMMENTS_PATH);
    expect(request?.url.searchParams.get("format")).toBe("markdown");
    expect(request?.url.searchParams.get("api-version")).toBe("7.1-preview.4");
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`:${TEST_PAT}`).toString("base64")}`
    );
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      text: run.summaryMarkdown,
    });
  });

  it("comments the run.triggered summary as a pre action", async () => {
    const fake = createFakeAdo([commentCreated]);
    const run = preActionRunSnapshot();

    const result = await addCommentAction.execute(
      createActionContext(fake, addCommentConfigSchema.parse({}), run)
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(run.event).toBe(WorkflowRunEvent.Triggered);
    const [request] = fake.requestsTo(HttpMethod.Post, COMMENTS_PATH);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      text: run.summaryMarkdown,
    });
  });

  it("skips runs whose source is not an Azure DevOps work item", async () => {
    const fake = createFakeAdo([commentCreated]);
    const run = runSnapshot({
      source: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10042",
        key: "PROJ-42",
        url: "https://contoso.atlassian.net/browse/PROJ-42",
        title: "Export",
        container: "PROJ",
      },
    });

    const result = await addCommentAction.execute(
      createActionContext(fake, addCommentConfigSchema.parse({}), run)
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(fake.requests).toHaveLength(0);
  });

  it("skips work items of another organization", async () => {
    const fake = createFakeAdo([commentCreated]);
    const base = runSnapshot();
    const run = runSnapshot({
      source: {
        ...base.source,
        url: `https://dev.azure.com/fabrikam/Web/_workitems/edit/${TEST_WORK_ITEM_ID}`,
      },
    });

    const result = await addCommentAction.execute(
      createActionContext(fake, addCommentConfigSchema.parse({}), run)
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(fake.requests).toHaveLength(0);
  });

  it("looks the project up when the run does not carry it", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, json: restWorkItem() },
      commentCreated,
    ]);
    const base = runSnapshot();
    const run = runSnapshot({ source: { ...base.source, container: null } });

    const result = await addCommentAction.execute(
      createActionContext(fake, { message: "PR: {{pr.url}}" }, run)
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    const [request] = fake.requestsTo(HttpMethod.Post, COMMENTS_PATH);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      text: "PR: https://github.com/contoso/shop/pull/42",
    });
  });

  it("marks outages as retryable failures", async () => {
    const fake = createFakeAdo([
      {
        ...commentCreated,
        status: 503,
        json: { message: "Service unavailable" },
      },
    ]);

    const result = await addCommentAction.execute(
      createActionContext(fake, addCommentConfigSchema.parse({}), runSnapshot())
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: expect.stringContaining("HTTP 503"),
      retryable: true,
    });
  });

  it("marks a rejected token as a final failure without leaking it", async () => {
    const fake = createFakeAdo([{ ...commentCreated, status: 401, json: {} }]);

    const result = await addCommentAction.execute(
      createActionContext(fake, addCommentConfigSchema.parse({}), runSnapshot())
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: `Could not add the comment: ${ADO_TOKEN_REJECTED_MESSAGE}`,
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(TEST_PAT);
  });

  it("skips a comment that renders empty", async () => {
    const fake = createFakeAdo([commentCreated]);

    const result = await addCommentAction.execute(
      createActionContext(
        fake,
        { message: "{{summary}}" },
        runSnapshot({ summaryMarkdown: "" })
      )
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("azure_devops.update_state", () => {
  it("patches System.State with a JSON Patch document", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        json: restWorkItem({ rev: 12 }),
      },
    ]);

    const result = await updateStateAction.execute(
      createActionContext(
        fake,
        updateStateConfigSchema.parse({ state: " Resolved " }),
        runSnapshot()
      )
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: `${TEST_WORK_ITEM_ID}:rev:12`,
      detail: `State of #${TEST_WORK_ITEM_ID} set to "Resolved"`,
    });
    const [request] = fake.requestsTo(HttpMethod.Patch, WORK_ITEM_PATH);
    expect(request?.headers.get("content-type")).toBe(
      "application/json-patch+json"
    );
    expect(request?.url.searchParams.get("api-version")).toBe("7.1");
    expect(JSON.parse(request?.body ?? "[]")).toEqual([
      {
        op: JsonPatchOperation.Add,
        path: `/fields/${AdoField.State}`,
        value: "Resolved",
      },
    ]);
  });

  it("sets the state as a pre action, before any plan or pull request exists", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        json: restWorkItem({ rev: 3 }),
      },
    ]);

    const result = await updateStateAction.execute(
      createActionContext(
        fake,
        updateStateConfigSchema.parse({ state: "Active" }),
        preActionRunSnapshot()
      )
    );

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: `${TEST_WORK_ITEM_ID}:rev:3`,
      detail: `State of #${TEST_WORK_ITEM_ID} set to "Active"`,
    });
    const [request] = fake.requestsTo(HttpMethod.Patch, WORK_ITEM_PATH);
    expect(JSON.parse(request?.body ?? "[]")).toEqual([
      {
        op: JsonPatchOperation.Add,
        path: `/fields/${AdoField.State}`,
        value: "Active",
      },
    ]);
  });

  it("reports an invalid state as a final failure with the ADO message", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        status: 400,
        json: {
          $id: "1",
          innerException: null,
          message:
            "TF401320: Rule Error for field State. Error code: Required, HasValues, LimitedToValues, AllowsOldValue, InvalidListValue.",
          typeName:
            "Microsoft.TeamFoundation.WorkItemTracking.Server.RuleValidationException",
          typeKey: "RuleValidationException",
          errorCode: 0,
          eventId: 3000,
        },
      },
    ]);

    const result = await updateStateAction.execute(
      createActionContext(fake, { state: "Shipped" }, runSnapshot())
    );

    expect(result.status).toBe(WorkflowActionRunStatus.Failed);
    expect(
      result.status === WorkflowActionRunStatus.Failed && result.retryable
    ).toBe(false);
    expect(
      result.status === WorkflowActionRunStatus.Failed ? result.error : ""
    ).toContain('Could not set the state to "Shipped"');
    expect(
      result.status === WorkflowActionRunStatus.Failed ? result.error : ""
    ).toContain("TF401320: Rule Error for field State");
    expect(JSON.stringify(result)).not.toContain(TEST_PAT);
  });

  it("requires a state in the config", () => {
    expect(updateStateConfigSchema.safeParse({ state: "  " }).success).toBe(
      false
    );
  });
});
