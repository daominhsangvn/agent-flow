import {
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { HttpMethod } from "../../../types";
import { markdownToAdf } from "../../atlassian/adf";
import {
  JIRA_DEFAULT_COMMENT_TEMPLATE,
  jiraAddCommentAction,
  jiraAddCommentConfigSchema,
  jiraTransitionIssueAction,
  jiraTransitionIssueConfigSchema,
} from "../actions";
import { JiraActionType, JiraCommentTarget } from "../constants";
import { TRANSITIONS } from "./jira.test-fixtures";
import {
  CLOUD_SITE_URL,
  DC_SITE_URL,
  dataCenterConfig,
  emptyResponse,
  type HttpRoute,
  jsonResponse,
  makeActionContext,
  makePreActionRunSnapshot,
  makeRunSnapshot,
  networkFailure,
  requestBody,
  routedHttp,
} from "./jira.test-helpers";

const COMMENT_PATH = "/rest/api/3/issue/10042/comment";
const TRANSITIONS_PATH = "/rest/api/3/issue/10042/transitions";

function commentContext(
  routes: HttpRoute[],
  overrides: { message?: string } = {}
) {
  const fake = routedHttp(routes);
  const ctx = makeActionContext({
    http: fake.http,
    config: jiraAddCommentConfigSchema.parse(overrides),
  });
  return { fake, ctx };
}

function transitionContext(routes: HttpRoute[], transitionName: string) {
  const fake = routedHttp(routes);
  const ctx = makeActionContext({
    http: fake.http,
    config: jiraTransitionIssueConfigSchema.parse({ transitionName }),
  });
  return { fake, ctx };
}

describe("jira.add_comment", () => {
  it("declares its config and default events", () => {
    expect(jiraAddCommentAction.key).toBe(JiraActionType.AddComment);
    expect(jiraAddCommentAction.defaultEvents).toEqual([
      WorkflowRunEvent.Started,
      WorkflowRunEvent.NeedsInput,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
    expect(
      jiraAddCommentAction.configFields.map((field) => [field.key, field.kind])
    ).toEqual([
      ["message", IntegrationFieldKind.Template],
      ["target", IntegrationFieldKind.Select],
    ]);
    expect(jiraAddCommentConfigSchema.parse({})).toEqual({
      message: JIRA_DEFAULT_COMMENT_TEMPLATE,
      target: JiraCommentTarget.Source,
    });
    expect(
      jiraAddCommentConfigSchema.safeParse({ target: "parent" }).success
    ).toBe(false);
  });

  it("posts the rendered summary as ADF on Jira Cloud", async () => {
    const { fake, ctx } = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(201, { id: "30001" }),
      },
    ]);
    const result = await jiraAddCommentAction.execute(ctx);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "30001",
      detail: "Comment 30001 added to PROJ-123.",
    });
    expect(fake.requests[0]?.url).toBe(`${CLOUD_SITE_URL}${COMMENT_PATH}`);
    expect(requestBody(fake.requests[0])).toEqual({
      body: markdownToAdf(ctx.run.summaryMarkdown),
    });
  });

  it("comments the run.triggered summary as a pre action", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(201, { id: "30002" }),
      },
    ]);
    const run = makePreActionRunSnapshot();
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraAddCommentConfigSchema.parse({}),
      run,
    });

    const result = await jiraAddCommentAction.execute(ctx);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "30002",
      detail: "Comment 30002 added to PROJ-123.",
    });
    expect(run.event).toBe(WorkflowRunEvent.Triggered);
    expect(requestBody(fake.requests[0])).toEqual({
      body: markdownToAdf(run.summaryMarkdown),
    });
  });

  it("posts plain text to REST v2 on Data Center", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Post,
        path: "/jira/rest/api/2/issue/10042/comment",
        respond: jsonResponse(201, { id: 40_001 }),
      },
    ]);
    const ctx = makeActionContext({
      http: fake.http,
      connectionConfig: dataCenterConfig(),
      config: jiraAddCommentConfigSchema.parse({ message: "Run: {{run.url}}" }),
      run: makeRunSnapshot({
        source: {
          provider: IntegrationProviderKey.Jira,
          externalId: "10042",
          key: "PROJ-123",
          url: `${DC_SITE_URL}/browse/PROJ-123`,
          title: "Add CSV export",
          container: "PROJ",
        },
      }),
    });
    const result = await jiraAddCommentAction.execute(ctx);
    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "40001",
      detail: "Comment 40001 added to PROJ-123.",
    });
    expect(requestBody(fake.requests[0])).toEqual({
      body: `Run: ${ctx.run.url}`,
    });
  });

  it("skips runs whose source is not a Jira issue on this site", async () => {
    const fake = routedHttp([]);
    const fromWebhook = makeActionContext({
      http: fake.http,
      config: jiraAddCommentConfigSchema.parse({}),
      run: makeRunSnapshot({
        source: {
          provider: IntegrationProviderKey.Webhook,
          externalId: "evt-1",
          key: "REQ-7",
          url: null,
          title: null,
          container: null,
        },
      }),
    });
    expect(await jiraAddCommentAction.execute(fromWebhook)).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason: "The run's source is not a Jira issue.",
    });
    const otherSite = makeActionContext({
      http: fake.http,
      config: jiraAddCommentConfigSchema.parse({}),
      run: makeRunSnapshot({
        source: {
          ...makeRunSnapshot().source,
          url: "https://other.atlassian.net/browse/PROJ-123",
        },
      }),
    });
    expect((await jiraAddCommentAction.execute(otherSite)).status).toBe(
      WorkflowActionRunStatus.Skipped
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("skips an empty comment", async () => {
    const { fake, ctx } = commentContext([], {
      message: "{{unknown.variable}}  ",
    });
    expect(await jiraAddCommentAction.execute(ctx)).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason: "The comment is empty after rendering the template.",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("classifies failures as retryable or final", async () => {
    const unavailable = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(503, {}),
      },
    ]);
    expect(await jiraAddCommentAction.execute(unavailable.ctx)).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "Could not add the comment on PROJ-123: Jira is unavailable (HTTP 503)",
      retryable: true,
    });
    const throttled = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(429, {}),
      },
    ]);
    expect(await jiraAddCommentAction.execute(throttled.ctx)).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: true,
    });
    const network = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: networkFailure(),
      },
    ]);
    expect(await jiraAddCommentAction.execute(network.ctx)).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: true,
    });
    const rejected = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(400, {
          errorMessages: [],
          errors: { comment: "Comment body can not be empty!" },
        }),
      },
    ]);
    expect(await jiraAddCommentAction.execute(rejected.ctx)).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "Could not add the comment on PROJ-123: Jira rejected the request (HTTP 400): Comment body can not be empty!",
      retryable: false,
    });
    const forbidden = commentContext([
      {
        method: HttpMethod.Post,
        path: COMMENT_PATH,
        respond: jsonResponse(403, {}),
      },
    ]);
    expect(await jiraAddCommentAction.execute(forbidden.ctx)).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: false,
    });
  });
});

describe("jira.transition_issue", () => {
  it("declares a required transition name and workflow.completed by default", () => {
    expect(jiraTransitionIssueAction.key).toBe(JiraActionType.TransitionIssue);
    expect(jiraTransitionIssueAction.defaultEvents).toEqual([
      WorkflowRunEvent.Succeeded,
    ]);
    expect(jiraTransitionIssueConfigSchema.safeParse({}).success).toBe(false);
    expect(
      jiraTransitionIssueConfigSchema.safeParse({ transitionName: " " }).success
    ).toBe(false);
  });

  it("finds the transition by name, case-insensitively, and performs it", async () => {
    const { fake, ctx } = transitionContext(
      [
        {
          method: HttpMethod.Get,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(200, TRANSITIONS),
        },
        {
          method: HttpMethod.Post,
          path: TRANSITIONS_PATH,
          respond: emptyResponse(204),
        },
      ],
      "request REVIEW"
    );
    expect(await jiraTransitionIssueAction.execute(ctx)).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "21",
      detail: 'Moved PROJ-123 with "Request review" to In Review.',
    });
    expect(requestBody(fake.requests[1])).toEqual({ transition: { id: "21" } });
  });

  it("moves the issue as a pre action, before any plan or pull request exists", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: TRANSITIONS_PATH,
        respond: jsonResponse(200, TRANSITIONS),
      },
      {
        method: HttpMethod.Post,
        path: TRANSITIONS_PATH,
        respond: emptyResponse(204),
      },
    ]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraTransitionIssueConfigSchema.parse({
        transitionName: "Start progress",
      }),
      run: makePreActionRunSnapshot(),
    });

    const result = await jiraTransitionIssueAction.execute(ctx);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "11",
      detail: 'Moved PROJ-123 with "Start progress" to In Progress.',
    });
    expect(requestBody(fake.requests[1])).toEqual({ transition: { id: "11" } });
  });

  it("falls back to the target status name", async () => {
    const { fake, ctx } = transitionContext(
      [
        {
          method: HttpMethod.Get,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(200, TRANSITIONS),
        },
        {
          method: HttpMethod.Post,
          path: TRANSITIONS_PATH,
          respond: emptyResponse(204),
        },
      ],
      "In Review"
    );
    const result = await jiraTransitionIssueAction.execute(ctx);
    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    expect(requestBody(fake.requests[1])).toEqual({ transition: { id: "21" } });
  });

  it("skips with the available transitions when none matches", async () => {
    const { fake, ctx } = transitionContext(
      [
        {
          method: HttpMethod.Get,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(200, TRANSITIONS),
        },
      ],
      "Deploy"
    );
    expect(await jiraTransitionIssueAction.execute(ctx)).toEqual({
      status: WorkflowActionRunStatus.Skipped,
      reason:
        'No transition "Deploy" is available for PROJ-123 (available: Start progress, Request review, Done).',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("fails retryably when Jira is down and finally on a rejected transition", async () => {
    const down = transitionContext(
      [
        {
          method: HttpMethod.Get,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(502, {}),
        },
      ],
      "Done"
    );
    expect(await jiraTransitionIssueAction.execute(down.ctx)).toMatchObject({
      status: WorkflowActionRunStatus.Failed,
      retryable: true,
    });
    const rejected = transitionContext(
      [
        {
          method: HttpMethod.Get,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(200, TRANSITIONS),
        },
        {
          method: HttpMethod.Post,
          path: TRANSITIONS_PATH,
          respond: jsonResponse(400, {
            errorMessages: ["Resolution is required."],
          }),
        },
      ],
      "Done"
    );
    expect(await jiraTransitionIssueAction.execute(rejected.ctx)).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error:
        "Could not transition the issue on PROJ-123: Jira rejected the request (HTTP 400): Resolution is required.",
      retryable: false,
    });
  });

  it("skips runs that did not come from Jira", async () => {
    const fake = routedHttp([]);
    const ctx = makeActionContext({
      http: fake.http,
      config: jiraTransitionIssueConfigSchema.parse({ transitionName: "Done" }),
      run: makeRunSnapshot({
        source: {
          provider: IntegrationProviderKey.AzureDevOps,
          externalId: "4567",
          key: "#4567",
          url: null,
          title: null,
          container: null,
        },
      }),
    });
    expect((await jiraTransitionIssueAction.execute(ctx)).status).toBe(
      WorkflowActionRunStatus.Skipped
    );
    expect(fake.requests).toHaveLength(0);
  });
});
