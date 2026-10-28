import { SourceOperation } from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { HttpMethod } from "../../../types";
import { JiraActionType } from "../constants";
import {
  jiraAddLinkAction,
  jiraAddLinkConfigSchema,
  jiraUpdateLabelsAction,
  jiraUpdateLabelsConfigSchema,
} from "../item-actions";
import {
  emptyResponse,
  jsonResponse,
  makeActionContext,
  makeRunSnapshot,
  requestBody,
  routedHttp,
} from "./jira.test-helpers";

/** jira.update_labels and jira.add_link (providers/jira/item-actions.ts). */

const ISSUE_PATH = "/rest/api/3/issue/10042";
const REMOTE_LINK_PATH = "/rest/api/3/issue/10042/remotelink";
const PAGE_URL = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123";

describe("jira.update_labels", () => {
  it("is the label write on the source issue", () => {
    expect(jiraUpdateLabelsAction.key).toBe(JiraActionType.UpdateLabels);
    expect(jiraUpdateLabelsAction.sourceOperation).toBe(SourceOperation.Label);
  });

  it("adds and removes labels in one update of the issue", async () => {
    const fake = routedHttp([
      { method: HttpMethod.Put, path: ISSUE_PATH, respond: emptyResponse(204) },
    ]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraUpdateLabelsConfigSchema.parse({
        add: ["plan-approved"],
        remove: ["replan"],
      }),
    });

    const result = await jiraUpdateLabelsAction.execute(ctx);

    expect(requestBody(fake.requests[0])).toEqual({
      update: { labels: [{ add: "plan-approved" }, { remove: "replan" }] },
    });
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      detail: "Labels of PROJ-123: +plan-approved, -replan.",
    });
  });

  it("refuses a change without labels, and labels with spaces", () => {
    expect(jiraUpdateLabelsConfigSchema.safeParse({}).success).toBe(false);
    expect(
      jiraUpdateLabelsConfigSchema.safeParse({ add: ["two words"] }).success
    ).toBe(false);
  });

  it("skips a run whose source is not a Jira issue", async () => {
    const fake = routedHttp([]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraUpdateLabelsConfigSchema.parse({ remove: ["replan"] }),
      run: makeRunSnapshot({
        source: {
          ...makeRunSnapshot().source,
          provider: IntegrationProviderKey.AzureDevOps,
        },
      }),
    });

    const result = await jiraUpdateLabelsAction.execute(ctx);

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(fake.requests).toHaveLength(0);
  });

  it("reports a refused update as a final failure", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Put,
        path: ISSUE_PATH,
        respond: jsonResponse(403, { errorMessages: ["No permission"] }),
      },
    ]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraUpdateLabelsConfigSchema.parse({ remove: ["replan"] }),
    });

    const result = await jiraUpdateLabelsAction.execute(ctx);

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
    });
  });
});

describe("jira.add_link", () => {
  it("is the link write on the source issue", () => {
    expect(jiraAddLinkAction.key).toBe(JiraActionType.AddLink);
    expect(jiraAddLinkAction.sourceOperation).toBe(SourceOperation.Link);
  });

  it("adds a web link keyed by its URL, so adding it again updates it", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: REMOTE_LINK_PATH,
        respond: jsonResponse(201, { id: 5, self: "x" }),
      },
    ]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraAddLinkConfigSchema.parse({
        url: PAGE_URL,
        title: "Implementation plan",
      }),
    });

    const result = await jiraAddLinkAction.execute(ctx);

    expect(requestBody(fake.requests[0])).toEqual({
      globalId: PAGE_URL,
      object: { url: PAGE_URL, title: "Implementation plan" },
    });
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: PAGE_URL,
    });
  });

  it("only links http and https addresses", () => {
    expect(
      jiraAddLinkConfigSchema.safeParse({
        url: "javascript:alert(1)",
        title: "x",
      }).success
    ).toBe(false);
  });
});
