import { SourceOperation } from "@repo/api/src/types/connection-grants";
import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  createActionContext,
  createFakeAdo,
  restWorkItem,
  runSnapshot,
  TEST_WORK_ITEM_ID,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  ADO_HYPERLINK_RELATION,
  AdoField,
  AzureDevOpsActionType,
  JsonPatchOperation,
} from "@/lib/integrations/providers/azure-devops/constants";
import {
  addLinkAction,
  addLinkConfigSchema,
  updateTagsAction,
  updateTagsConfigSchema,
} from "@/lib/integrations/providers/azure-devops/item-actions";
import { HttpMethod } from "@/lib/integrations/types";

/** azure_devops.update_tags and azure_devops.add_link (item-actions.ts). */

const WORK_ITEM_PATH = `/contoso/_apis/wit/workitems/${TEST_WORK_ITEM_ID}`;
const PAGE_URL = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123";

describe("azure_devops.update_tags", () => {
  it("is the label write on the source work item", () => {
    expect(updateTagsAction.key).toBe(AzureDevOpsActionType.UpdateTags);
    expect(updateTagsAction.sourceOperation).toBe(SourceOperation.Label);
  });

  it("rewrites the tags from the ones read, under a test of that revision", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: WORK_ITEM_PATH,
        json: restWorkItem({
          rev: 7,
          fields: { [AdoField.Tags]: "ai-ready; Replan; backend" },
        }),
      },
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        json: restWorkItem({ rev: 8 }),
      },
    ]);

    const result = await updateTagsAction.execute(
      createActionContext(
        fake,
        updateTagsConfigSchema.parse({
          add: ["plan-approved", "backend"],
          remove: ["replan"],
        }),
        runSnapshot()
      )
    );

    const [patch] = fake.requestsTo(HttpMethod.Patch, WORK_ITEM_PATH);
    expect(JSON.parse(patch?.body ?? "[]")).toEqual([
      { op: JsonPatchOperation.Test, path: "/rev", value: 7 },
      {
        op: JsonPatchOperation.Add,
        path: `/fields/${AdoField.Tags}`,
        value: "ai-ready; backend; plan-approved",
      },
    ]);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: `${TEST_WORK_ITEM_ID}:rev:8`,
      detail: `Tags of #${TEST_WORK_ITEM_ID}: ai-ready, backend, plan-approved`,
    });
  });

  it("fails retryably when the work item changed in between", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, json: restWorkItem() },
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        status: 503,
        json: { message: "Service unavailable" },
      },
    ]);

    const result = await updateTagsAction.execute(
      createActionContext(
        fake,
        updateTagsConfigSchema.parse({ remove: ["replan"] }),
        runSnapshot()
      )
    );

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: true,
    });
  });
});

describe("azure_devops.add_link", () => {
  it("is the link write on the source work item", () => {
    expect(addLinkAction.key).toBe(AzureDevOpsActionType.AddLink);
    expect(addLinkAction.sourceOperation).toBe(SourceOperation.Link);
  });

  it("adds a Hyperlink relation with the title as its comment", async () => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: WORK_ITEM_PATH, json: restWorkItem() },
      {
        method: HttpMethod.Patch,
        path: WORK_ITEM_PATH,
        json: restWorkItem({ rev: 10 }),
      },
    ]);

    const result = await addLinkAction.execute(
      createActionContext(
        fake,
        addLinkConfigSchema.parse({
          url: PAGE_URL,
          title: "Implementation plan",
        }),
        runSnapshot()
      )
    );

    const [read] = fake.requestsTo(HttpMethod.Get, WORK_ITEM_PATH);
    expect(read?.url.searchParams.get("$expand")).toBe("relations");
    const [patch] = fake.requestsTo(HttpMethod.Patch, WORK_ITEM_PATH);
    expect(JSON.parse(patch?.body ?? "[]")).toEqual([
      {
        op: JsonPatchOperation.Add,
        path: "/relations/-",
        value: {
          rel: ADO_HYPERLINK_RELATION,
          url: PAGE_URL,
          attributes: { comment: "Implementation plan" },
        },
      },
    ]);
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: PAGE_URL,
    });
  });

  it("does not add a link the work item already has", async () => {
    const linked = restWorkItem();
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: WORK_ITEM_PATH,
        json: {
          ...linked,
          relations: [{ rel: ADO_HYPERLINK_RELATION, url: PAGE_URL }],
        },
      },
    ]);

    const result = await addLinkAction.execute(
      createActionContext(
        fake,
        addLinkConfigSchema.parse({ url: PAGE_URL, title: "Plan" }),
        runSnapshot()
      )
    );

    expect(fake.requestsTo(HttpMethod.Patch, WORK_ITEM_PATH)).toHaveLength(0);
    expect(result).toMatchObject({ status: WorkflowActionRunStatus.Succeeded });
  });
});
