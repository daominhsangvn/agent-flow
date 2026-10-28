import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { HttpMethod, RetryableSourceError } from "../../../types";
import { JiraEventAttribute, JiraTriggerType } from "../constants";
import {
  fetchJiraIssue,
  JIRA_COMMENT_LIMIT,
  JIRA_INVALID_ISSUE_REFERENCE,
  parseJiraIssueReference,
  resolveJiraManual,
} from "../source";
import {
  restCommentsNewestFirst,
  restIssue,
  webhookIssue,
} from "./jira.test-fixtures";
import {
  CLOUD_SITE_URL,
  DC_SITE_URL,
  dataCenterConfig,
  type HttpRoute,
  jsonResponse,
  makeJiraContext,
  NOW,
  networkFailure,
  requestQuery,
  routedHttp,
} from "./jira.test-helpers";

const ISSUE_REF = {
  provider: IntegrationProviderKey.Jira,
  externalId: "10042",
  key: "PROJ-123",
  url: `${CLOUD_SITE_URL}/browse/PROJ-123`,
  title: "Add CSV export",
  container: "PROJ",
};

describe("fetchJiraIssue", () => {
  it("maps the rendered issue, acceptance criteria, comments and attachments", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042",
        respond: jsonResponse(200, restIssue()),
      },
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042/comment",
        respond: jsonResponse(200, restCommentsNewestFirst()),
      },
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042/remotelink",
        respond: jsonResponse(200, [
          {
            id: 5,
            object: {
              url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
              title: "Implementation plan",
            },
          },
          { id: 6, object: { title: "No address" } },
        ]),
      },
    ]);
    const item = await fetchJiraIssue(
      makeJiraContext({ http: fake.http }),
      ISSUE_REF
    );
    expect(item).toEqual({
      provider: IntegrationProviderKey.Jira,
      externalId: "10042",
      key: "PROJ-123",
      url: `${CLOUD_SITE_URL}/browse/PROJ-123`,
      title: "Add CSV export to the reports page",
      container: "PROJ",
      bodyMarkdown:
        "## Goal\n\nUsers can export the report as **CSV**.\n\n* one\n* two",
      itemType: "Story",
      status: "To Do",
      priority: "High",
      labels: ["ai-ready", "reports"],
      links: [
        {
          url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          title: "Implementation plan",
        },
      ],
      reporter: "Bea Analyst",
      assignee: "AgentFlow Bot",
      reporterEmail: null,
      assigneeEmail: null,
      sections: [
        {
          title: "Acceptance Criteria",
          markdown:
            "* Given a report, when I click Export, then a CSV downloads",
        },
      ],
      comments: [
        {
          id: "20001",
          parentId: null,
          author: "Bea Analyst",
          createdAt: "2026-10-04T11:40:00.000Z",
          bodyMarkdown: "First comment",
        },
        {
          id: "20002",
          parentId: "20001",
          author: "Bea Analyst",
          createdAt: "2026-10-04T11:55:00.000Z",
          bodyMarkdown: "Please also support _semicolons_.",
        },
      ],
      attachments: [
        {
          name: "mockup.png",
          url: `${CLOUD_SITE_URL}/rest/api/3/attachment/content/10500`,
          mimeType: "image/png",
          size: 48_213,
        },
      ],
    });
    const issueQuery = requestQuery(fake.requests[0]);
    expect(issueQuery.get("fields")).toBe("*all,-comment");
    expect(issueQuery.get("expand")).toBe("renderedFields,names");
    const commentQuery = requestQuery(fake.requests[1]);
    expect(commentQuery.get("orderBy")).toBe("-created");
    expect(commentQuery.get("maxResults")).toBe(String(JIRA_COMMENT_LIMIT));
    expect(commentQuery.get("expand")).toBe("renderedBody");
  });

  it("falls back to raw values when rendered fields are missing", async () => {
    const issue = restIssue();
    const dcIssue = {
      ...issue,
      renderedFields: undefined,
      fields: {
        ...issue.fields,
        description: "h2. Goal\nPlain wiki markup",
      },
    };
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/jira/rest/api/2/issue/10042",
        respond: jsonResponse(200, dcIssue),
      },
      {
        method: HttpMethod.Get,
        path: "/jira/rest/api/2/issue/10042/comment",
        respond: jsonResponse(200, {
          comments: [
            {
              id: "1",
              author: { displayName: "Bea" },
              body: "wiki *comment*",
              created: "2026-10-04T11:00:00.000+0000",
            },
          ],
        }),
      },
    ]);
    const item = await fetchJiraIssue(
      makeJiraContext({ http: fake.http, config: dataCenterConfig() }),
      { ...ISSUE_REF, url: `${DC_SITE_URL}/browse/PROJ-123` }
    );
    expect(item.bodyMarkdown).toBe("h2. Goal\nPlain wiki markup");
    expect(item.sections).toEqual([
      { title: "Acceptance Criteria", markdown: "Given a report" },
    ]);
    expect(item.comments).toEqual([
      {
        id: "1",
        parentId: null,
        author: "Bea",
        createdAt: "2026-10-04T11:00:00.000Z",
        bodyMarkdown: "wiki *comment*",
      },
    ]);
    expect(item.url).toBe(`${DC_SITE_URL}/browse/PROJ-123`);
  });

  it("imports without comments when the comment request fails", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042",
        respond: jsonResponse(200, restIssue()),
      },
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042/comment",
        respond: jsonResponse(500, {}),
      },
    ]);
    const item = await fetchJiraIssue(
      makeJiraContext({ http: fake.http }),
      ISSUE_REF
    );
    expect(item.comments).toEqual([]);
    expect(item.title).toBe("Add CSV export to the reports page");
  });

  it("throws a readable error when the issue cannot be loaded", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042",
        respond: jsonResponse(404, {
          errorMessages: [
            "Issue does not exist or you do not have permission to see it.",
          ],
        }),
      },
    ]);
    await expect(
      fetchJiraIssue(makeJiraContext({ http: fake.http }), ISSUE_REF)
    ).rejects.toThrow(
      "Could not load Jira issue PROJ-123: Not found in Jira (HTTP 404): Issue does not exist or you do not have permission to see it."
    );
  });

  it("uses the key when the reference has no external id", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/PROJ-123",
        respond: jsonResponse(200, restIssue()),
      },
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/10042/comment",
        respond: jsonResponse(200, { comments: [] }),
      },
    ]);
    const item = await fetchJiraIssue(makeJiraContext({ http: fake.http }), {
      ...ISSUE_REF,
      externalId: "",
    });
    expect(item.externalId).toBe("10042");
  });
});

describe("Jira source failures", () => {
  const TEMPORARY_FAILURES = [
    [
      "rate limited (429)",
      jsonResponse(429, {}),
      "Jira is unavailable (HTTP 429)",
    ],
    [
      "unavailable (503)",
      jsonResponse(503, { errorMessages: ["Service Unavailable"] }),
      "Jira is unavailable (HTTP 503): Service Unavailable",
    ],
    [
      "unreachable (network error or timeout)",
      networkFailure(),
      "Could not reach Jira (fetch failed)",
    ],
  ] as const;

  function issueRoute(
    path: string,
    respond: HttpRoute["respond"]
  ): HttpRoute[] {
    return [{ method: HttpMethod.Get, path, respond }];
  }

  it.each(
    TEMPORARY_FAILURES
  )("fetchItem throws a RetryableSourceError when Jira is %s", async (_label, response, detail) => {
    const fake = routedHttp(issueRoute("/rest/api/3/issue/10042", response));

    const error = await fetchJiraIssue(
      makeJiraContext({ http: fake.http }),
      ISSUE_REF
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RetryableSourceError);
    expect(error).toHaveProperty(
      "message",
      `Could not load Jira issue PROJ-123: ${detail}`
    );
  });

  it.each(
    TEMPORARY_FAILURES
  )("resolveManual throws a RetryableSourceError when Jira is %s", async (_label, response, detail) => {
    const fake = routedHttp(issueRoute("/rest/api/3/issue/PROJ-123", response));

    const error = await resolveJiraManual(
      makeJiraContext({ http: fake.http }),
      "PROJ-123",
      JiraTriggerType.IssueAssigned
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RetryableSourceError);
    expect(error).toHaveProperty(
      "message",
      `Could not load Jira issue PROJ-123: ${detail}`
    );
  });

  it.each([
    ["not found (404)", jsonResponse(404, {})],
    ["denied (403)", jsonResponse(403, {})],
    ["rejecting the credentials (401)", jsonResponse(401, {})],
    ["answering with an unexpected body", jsonResponse(200, { id: 1 })],
  ])("keeps a plain Error when Jira is %s", async (_label, response) => {
    const fetchHttp = routedHttp(
      issueRoute("/rest/api/3/issue/10042", response)
    );
    const manualHttp = routedHttp(
      issueRoute("/rest/api/3/issue/PROJ-123", response)
    );

    const fetchError = await fetchJiraIssue(
      makeJiraContext({ http: fetchHttp.http }),
      ISSUE_REF
    ).catch((thrown: unknown) => thrown);
    const manualError = await resolveJiraManual(
      makeJiraContext({ http: manualHttp.http }),
      "PROJ-123",
      JiraTriggerType.IssueAssigned
    ).catch((thrown: unknown) => thrown);

    for (const error of [fetchError, manualError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableSourceError);
    }
  });
});

describe("parseJiraIssueReference", () => {
  it("accepts issue keys in any case", () => {
    expect(parseJiraIssueReference(" proj-123 ", CLOUD_SITE_URL)).toEqual({
      ok: true,
      value: "PROJ-123",
    });
  });

  it("extracts the key from browse, board and selectedIssue links on the site", () => {
    const parse = (input: string) =>
      parseJiraIssueReference(input, CLOUD_SITE_URL);
    expect(parse(`${CLOUD_SITE_URL}/browse/PROJ-123`)).toEqual({
      ok: true,
      value: "PROJ-123",
    });
    expect(
      parse(
        `${CLOUD_SITE_URL}/jira/software/c/projects/PROJ/issues/PROJ-9?filter=x`
      )
    ).toEqual({
      ok: true,
      value: "PROJ-9",
    });
    expect(
      parse(
        `${CLOUD_SITE_URL}/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-77`
      )
    ).toEqual({
      ok: true,
      value: "PROJ-77",
    });
  });

  it("rejects links to another site and input without a key", () => {
    expect(
      parseJiraIssueReference(
        "https://other.atlassian.net/browse/PROJ-1",
        CLOUD_SITE_URL
      )
    ).toEqual({
      ok: false,
      error:
        "The link is not on this connection's Jira site (acme.atlassian.net).",
    });
    expect(parseJiraIssueReference("PROJ 123", CLOUD_SITE_URL)).toEqual({
      ok: false,
      error: JIRA_INVALID_ISSUE_REFERENCE,
    });
    expect(
      parseJiraIssueReference(`${CLOUD_SITE_URL}/browse/`, CLOUD_SITE_URL)
    ).toEqual({
      ok: false,
      error: JIRA_INVALID_ISSUE_REFERENCE,
    });
  });
});

describe("resolveJiraManual", () => {
  function manualHttp() {
    return routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/PROJ-123",
        respond: jsonResponse(200, webhookIssue()),
      },
    ]);
  }

  it("builds an assigned event with a manual dedupKey", async () => {
    const fake = manualHttp();
    const event = await resolveJiraManual(
      makeJiraContext({ http: fake.http }),
      `${CLOUD_SITE_URL}/browse/proj-123`,
      JiraTriggerType.IssueAssigned
    );
    expect(event).toEqual({
      triggerType: JiraTriggerType.IssueAssigned,
      dedupKey: "PROJ-123:manual",
      occurredAt: NOW,
      actor: null,
      item: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10042",
        key: "PROJ-123",
        url: `${CLOUD_SITE_URL}/browse/PROJ-123`,
        title: "Add CSV export to the reports page",
        container: "PROJ",
      },
      attributes: {
        [JiraEventAttribute.ProjectKey]: "PROJ",
        [JiraEventAttribute.IssueType]: "Story",
        [JiraEventAttribute.Labels]: ["ai-ready", "reports"],
        [JiraEventAttribute.Status]: "To Do",
      },
    });
    expect(requestQuery(fake.requests[0]).get("fields")).toBe(
      "summary,issuetype,labels,status,project,assignee"
    );
  });

  it("treats the current labels as added for a label trigger", async () => {
    const event = await resolveJiraManual(
      makeJiraContext({ http: manualHttp().http }),
      "PROJ-123",
      JiraTriggerType.IssueLabeled
    );
    expect(event.triggerType).toBe(JiraTriggerType.IssueLabeled);
    expect(event.attributes[JiraEventAttribute.AddedLabels]).toEqual([
      "ai-ready",
      "reports",
    ]);
  });

  it("throws user-facing errors for bad input, unknown issues and other trigger types", async () => {
    const ctx = makeJiraContext({ http: manualHttp().http });
    await expect(
      resolveJiraManual(ctx, "not a key", JiraTriggerType.IssueAssigned)
    ).rejects.toThrow(JIRA_INVALID_ISSUE_REFERENCE);
    await expect(
      resolveJiraManual(ctx, "PROJ-999", JiraTriggerType.IssueAssigned)
    ).rejects.toThrow(
      "Jira issue PROJ-999 was not found, or the bot account cannot see it."
    );
    await expect(
      resolveJiraManual(ctx, "PROJ-123", "azure_devops.work_item_assigned")
    ).rejects.toThrow(
      'Jira cannot start a run for the trigger type "azure_devops.work_item_assigned".'
    );
  });
});
