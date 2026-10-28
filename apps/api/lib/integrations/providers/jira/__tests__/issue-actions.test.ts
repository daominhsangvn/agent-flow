import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import type { ActionContext } from "../../../types";
import { HttpMethod } from "../../../types";
import { JiraActionType } from "../constants";
import {
  type JiraCreateIssueConfig,
  jiraCreateIssueAction,
  jiraCreateIssueConfigSchema,
} from "../issue-actions";
import type { JiraConnectionConfig, JiraSecrets } from "../schemas";
import {
  emptyResponse,
  type HttpRoute,
  jsonResponse,
  makeActionContext,
  requestBody,
  requestQuery,
  routedHttp,
} from "./jira.test-helpers";

/** jira.create_issue (providers/jira/issue-actions.ts). */

const CREATE_PATH = "/rest/api/3/issue";
const LINK_TYPES_PATH = "/rest/api/3/issueLinkType";
const LINK_PATH = "/rest/api/3/issueLink";
const SEARCH_PATH = "/rest/api/3/search/jql";

const IMPLEMENTS = {
  id: "10300",
  name: "Polaris work item link",
  inward: "is implemented by",
  outward: "implements",
};
const BLOCKS = {
  id: "10000",
  name: "Blocks",
  inward: "is blocked by",
  outward: "blocks",
};

const created = (key = "PROJ-130"): HttpRoute => ({
  method: HttpMethod.Post,
  path: CREATE_PATH,
  respond: jsonResponse(201, { id: "10130", key, self: "x" }),
});
const linkTypes: HttpRoute = {
  method: HttpMethod.Get,
  path: LINK_TYPES_PATH,
  respond: jsonResponse(200, { issueLinkTypes: [BLOCKS, IMPLEMENTS] }),
};
const linked: HttpRoute = {
  method: HttpMethod.Post,
  path: LINK_PATH,
  respond: emptyResponse(201),
};

function context(
  routes: HttpRoute[],
  config: Partial<JiraCreateIssueConfig> & { summary?: string },
  options: { projectKeys?: string[] | null; attempt?: number } = {}
): {
  ctx: ActionContext<JiraCreateIssueConfig, JiraConnectionConfig, JiraSecrets>;
  requests: ReturnType<typeof routedHttp>["requests"];
} {
  const fake = routedHttp(routes);
  const base = makeActionContext({
    http: fake.http,
    attempt: options.attempt,
    config: jiraCreateIssueConfigSchema.parse({
      summary: "Leave balances",
      ...config,
    }),
  });
  const projectKeys =
    options.projectKeys === undefined ? ["PROJ"] : options.projectKeys;
  return {
    ctx: {
      ...base,
      connection: {
        ...base.connection,
        ...(projectKeys ? { projectSettings: { projectKeys } } : {}),
      },
    },
    requests: fake.requests,
  };
}

describe("jira.create_issue", () => {
  it("is an external operation, not a write on the source issue", () => {
    expect(jiraCreateIssueAction.key).toBe(JiraActionType.CreateIssue);
    expect(jiraCreateIssueAction.sourceOperation).toBeUndefined();
  });

  it("creates a story in the source issue's project with the description as rich text", async () => {
    const { ctx, requests } = context([created()], {
      description: "## Goal\n\nShow **balances**.",
      labels: ["prd"],
    });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(requestBody(requests[0])).toMatchObject({
      fields: {
        project: { key: "PROJ" },
        issuetype: { name: "Story" },
        summary: "Leave balances",
        labels: ["prd"],
        description: { type: "doc", version: 1 },
      },
    });
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "PROJ-130",
      detail:
        "Created PROJ-130 (https://acme.atlassian.net/browse/PROJ-130) in PROJ.",
    });
  });

  it("links the new issue to the source issue by the phrase read from the new issue", async () => {
    const { ctx, requests } = context([created(), linkTypes, linked], {
      linkType: "Implements",
    });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(requestBody(requests.at(-1))).toEqual({
      type: { id: IMPLEMENTS.id },
      inwardIssue: { key: "PROJ-130" },
      outwardIssue: { key: "PROJ-123" },
    });
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: expect.stringContaining("which implements PROJ-123"),
    });
  });

  it("puts the new issue at the outward end for an inward phrase", async () => {
    const { ctx, requests } = context([created(), linkTypes, linked], {
      linkType: "is blocked by",
    });

    await jiraCreateIssueAction.execute(ctx);

    expect(requestBody(requests.at(-1))).toEqual({
      type: { id: BLOCKS.id },
      inwardIssue: { key: "PROJ-123" },
      outwardIssue: { key: "PROJ-130" },
    });
  });

  it("fails before creating anything when the link type does not exist", async () => {
    const { ctx, requests } = context([created(), linkTypes], {
      linkType: "clones",
    });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(requests.map((request) => request.method)).toEqual([HttpMethod.Get]);
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
      error: expect.stringContaining("implements / is implemented by"),
    });
  });

  it("refuses a project or linked issue outside the project connection's projects", async () => {
    const project = context([created()], { projectKey: "OPS" });
    const link = context([created(), linkTypes], {
      linkType: "implements",
      linkIssue: "OPS-1",
    });

    const results = [
      await jiraCreateIssueAction.execute(project.ctx),
      await jiraCreateIssueAction.execute(link.ctx),
    ];

    expect(results.map((result) => result.status)).toEqual([
      WorkflowActionRunStatus.Failed,
      WorkflowActionRunStatus.Failed,
    ]);
    expect(project.requests).toHaveLength(0);
    expect(link.requests).toHaveLength(0);
  });

  it("is skipped without a project connection naming Jira projects", async () => {
    const { ctx, requests } = context([created()], {}, { projectKeys: null });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(requests).toHaveLength(0);
  });

  it("finds the issue an earlier attempt created instead of creating it again", async () => {
    const search: HttpRoute = {
      method: HttpMethod.Get,
      path: SEARCH_PATH,
      respond: jsonResponse(200, {
        issues: [
          {
            id: "10129",
            key: "PROJ-129",
            fields: { summary: "Leave balances" },
          },
        ],
      }),
    };
    const { ctx, requests } = context([search, created()], {}, { attempt: 2 });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(requestQuery(requests[0]).get("jql")).toContain(
      'summary ~ "Leave balances"'
    );
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ externalRef: "PROJ-129" });
  });

  it("does not retry a failed link once the issue exists", async () => {
    const { ctx } = context(
      [
        created(),
        linkTypes,
        {
          method: HttpMethod.Post,
          path: LINK_PATH,
          respond: jsonResponse(503, {}),
        },
      ],
      { linkType: "implements" }
    );

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
      error: expect.stringContaining("Created PROJ-130, but"),
    });
  });
  it("continues a description too long for one Jira field in comments", async () => {
    const paragraph = (index: number) =>
      `## Section ${index}\n\n${"Lorem ipsum dolor. ".repeat(400)}`;
    const description = Array.from({ length: 12 }, (_, index) =>
      paragraph(index + 1)
    ).join("\n\n");
    const comment: HttpRoute = {
      method: HttpMethod.Post,
      path: "/rest/api/3/issue/PROJ-130/comment",
      respond: jsonResponse(201, { id: "1" }),
    };
    const { ctx, requests } = context([created(), comment], { description });

    const result = await jiraCreateIssueAction.execute(ctx);

    const bodies = requests.map((request) =>
      JSON.stringify(requestBody(request))
    );
    expect(requests.length).toBeGreaterThan(2);
    for (const body of bodies) {
      expect(body.length).toBeLessThan(32_767);
    }
    expect(bodies.join("")).toContain("Section 12");
    expect(bodies[1]).toContain(
      `Description, continued (2/${requests.length})`
    );
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: expect.stringContaining(
        `continues in ${requests.length - 1} comment(s)`
      ),
    });
  });
  it("attaches the text file to the new issue", async () => {
    const attach: HttpRoute = {
      method: HttpMethod.Post,
      path: "/rest/api/3/issue/10130/attachments",
      respond: jsonResponse(200, [
        { id: "20001", filename: "PRD.md", mimeType: "text/markdown" },
      ]),
    };
    const { ctx, requests } = context([created(), attach], {
      description: "Summary of the PRD.",
      attachmentName: "PRD.md",
      attachmentContent: "# PRD\n\nThe whole document.",
    });

    const result = await jiraCreateIssueAction.execute(ctx);

    const upload = requests[1]?.body;
    expect(upload).toBeInstanceOf(FormData);
    const file = (upload as FormData).get("file") as File;
    expect(file.name).toBe("PRD.md");
    expect(file.type).toBe("text/markdown");
    expect(await file.text()).toBe("# PRD\n\nThe whole document.");
    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      detail: expect.stringContaining("attached PRD.md"),
    });
  });

  it("refuses attachment content without a file name", async () => {
    const { ctx, requests } = context([created()], {
      attachmentContent: "text",
    });

    const result = await jiraCreateIssueAction.execute(ctx);

    expect(result.status).toBe(WorkflowActionRunStatus.Failed);
    expect(requests).toHaveLength(0);
  });
});
