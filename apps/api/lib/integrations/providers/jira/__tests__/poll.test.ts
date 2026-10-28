import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { HttpMethod } from "../../../types";
import { JiraEventAttribute, JiraTriggerType } from "../constants";
import {
  JIRA_POLL_BOT_UNKNOWN_ERROR,
  JIRA_POLL_MAX_ISSUES,
  pollJira,
} from "../poll";
import {
  jiraIssueConditionsConfigSchema,
  jiraIssueConditionsTrigger,
} from "../triggers";
import {
  assigneeItem,
  BOT_USER,
  history,
  labelsItem,
  searchIssue,
} from "./jira.test-fixtures";
import {
  BOT_ACCOUNT_ID,
  CLOUD_SITE_URL,
  DC_BOT_ACCOUNT,
  dataCenterConfig,
  type HttpRoute,
  HUMAN_ACCOUNT_ID,
  jsonResponse,
  makeJiraContext,
  NOW,
  requestQuery,
  routedHttp,
} from "./jira.test-helpers";

const SEARCH_PATH = "/rest/api/3/search/jql";

function searchRoute(body: unknown, path = SEARCH_PATH): HttpRoute {
  return { method: HttpMethod.Get, path, respond: jsonResponse(200, body) };
}

/** Changes around the default window (first poll: since 11:55, window from 11:53). */
function firstPollIssues() {
  return [
    searchIssue({
      id: "1001",
      key: "PROJ-1",
      created: "2026-10-01T09:00:00.000+0000",
      updated: "2026-10-04T11:59:30.000+0000",
      histories: [
        history({
          id: "h-old",
          created: "2026-10-04T11:00:00.000+0000",
          items: [assigneeItem(null, BOT_ACCOUNT_ID)],
        }),
        history({
          id: "h-new",
          created: "2026-10-04T11:58:00.000+0000",
          items: [assigneeItem(HUMAN_ACCOUNT_ID, BOT_ACCOUNT_ID)],
        }),
      ],
    }),
    searchIssue({
      id: "1002",
      key: "PROJ-2",
      created: "2026-10-01T09:00:00.000+0000",
      updated: "2026-10-04T11:57:00.000+0000",
      histories: [
        history({
          id: "h-bot",
          created: "2026-10-04T11:57:00.000+0000",
          author: BOT_USER,
          items: [assigneeItem(HUMAN_ACCOUNT_ID, BOT_ACCOUNT_ID)],
        }),
      ],
    }),
    searchIssue({
      id: "1004",
      key: "PROJ-4",
      created: "2026-10-04T11:56:00.000+0000",
      updated: "2026-10-04T11:56:00.000+0000",
    }),
    searchIssue({
      id: "1005",
      key: "PROJ-5",
      created: "2026-10-04T11:56:00.000+0000",
      updated: "2026-10-04T11:57:00.000+0000",
      histories: [
        history({
          id: "h5",
          created: "2026-10-04T11:57:00.000+0000",
          items: [assigneeItem(null, BOT_ACCOUNT_ID)],
        }),
      ],
    }),
    searchIssue({
      id: "1006",
      key: "PROJ-6",
      created: "2026-10-04T11:55:00.000+0000",
      updated: "2026-10-04T11:58:30.000+0000",
      histories: [
        history({
          id: "h6b",
          created: "2026-10-04T11:58:30.000+0000",
          items: [assigneeItem(HUMAN_ACCOUNT_ID, BOT_ACCOUNT_ID)],
        }),
        history({
          id: "h6a",
          created: "2026-10-04T11:56:00.000+0000",
          items: [assigneeItem(BOT_ACCOUNT_ID, HUMAN_ACCOUNT_ID)],
        }),
      ],
    }),
  ];
}

describe("pollJira", () => {
  it("queries issues assigned to the bot changed in the first-poll window", async () => {
    const fake = routedHttp([searchRoute({ issues: [], isLast: true })]);
    await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(fake.requests).toHaveLength(1);
    const query = requestQuery(fake.requests[0]);
    expect(
      fake.requests[0]?.url.startsWith(`${CLOUD_SITE_URL}${SEARCH_PATH}?`)
    ).toBe(true);
    expect(query.get("jql")).toBe(
      'assignee = currentUser() AND updated >= "-8m" ORDER BY updated ASC'
    );
    expect(query.get("expand")).toBe("changelog");
    expect(query.get("maxResults")).toBe(String(JIRA_POLL_MAX_ISSUES));
    expect(query.get("fields")?.split(",")).toEqual(
      expect.arrayContaining([
        "summary",
        "issuetype",
        "labels",
        "status",
        "assignee",
        "project",
        "created",
        "updated",
      ])
    );
  });

  it("emits assignment events in the window and advances the cursor", async () => {
    const fake = routedHttp([
      searchRoute({ issues: firstPollIssues(), isLast: true }),
    ]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(
      result.events.map((event) => [
        event.triggerType,
        event.dedupKey,
        event.occurredAt.toISOString(),
      ])
    ).toEqual([
      [
        JiraTriggerType.IssueAssigned,
        "PROJ-1:assignee:h-new",
        "2026-10-04T11:58:00.000Z",
      ],
      [
        JiraTriggerType.IssueConditions,
        "PROJ-1:conditions:h-new",
        "2026-10-04T11:58:00.000Z",
      ],
      [
        JiraTriggerType.IssueAssigned,
        "PROJ-4:created",
        "2026-10-04T11:56:00.000Z",
      ],
      [
        JiraTriggerType.IssueConditions,
        "PROJ-4:conditions:created",
        "2026-10-04T11:56:00.000Z",
      ],
      [
        JiraTriggerType.IssueAssigned,
        "PROJ-5:assignee:h5",
        "2026-10-04T11:57:00.000Z",
      ],
      [
        JiraTriggerType.IssueConditions,
        "PROJ-5:conditions:h5",
        "2026-10-04T11:57:00.000Z",
      ],
      [
        JiraTriggerType.IssueAssigned,
        "PROJ-6:created",
        "2026-10-04T11:55:00.000Z",
      ],
      [
        JiraTriggerType.IssueAssigned,
        "PROJ-6:assignee:h6b",
        "2026-10-04T11:58:30.000Z",
      ],
      [
        JiraTriggerType.IssueConditions,
        "PROJ-6:conditions:created",
        "2026-10-04T11:55:00.000Z",
      ],
      [
        JiraTriggerType.IssueConditions,
        "PROJ-6:conditions:h6b",
        "2026-10-04T11:58:30.000Z",
      ],
    ]);
    expect(result.events[0]?.actor).toEqual({
      id: HUMAN_ACCOUNT_ID,
      displayName: "Bea Analyst",
    });
    expect(result.events[0]?.item).toEqual({
      provider: IntegrationProviderKey.Jira,
      externalId: "1001",
      key: "PROJ-1",
      url: `${CLOUD_SITE_URL}/browse/PROJ-1`,
      title: "Issue PROJ-1",
      container: "PROJ",
    });
    // Newest update (11:59:30) is later than now - 1 min (11:59:00).
    expect(result.cursor).toEqual({ since: "2026-10-04T11:59:30.000Z" });
  });

  it("continues from the cursor with a two-minute overlap", async () => {
    const fake = routedHttp([searchRoute({ issues: [], isLast: true })]);
    const result = await pollJira(
      makeJiraContext({
        http: fake.http,
        now: new Date("2026-10-04T12:02:00.000Z"),
      }),
      { since: "2026-10-04T11:59:30.000Z" }
    );
    expect(requestQuery(fake.requests[0]).get("jql")).toContain(
      'updated >= "-6m"'
    );
    expect(result).toEqual({
      events: [],
      cursor: { since: "2026-10-04T12:01:00.000Z" },
    });
  });

  it("clamps a stale cursor to 24 hours and treats an invalid cursor as a first poll", async () => {
    const fake = routedHttp([searchRoute({ issues: [], isLast: true })]);
    const ctx = makeJiraContext({ http: fake.http });
    await pollJira(ctx, { since: "2026-09-01T00:00:00.000Z" });
    await pollJira(ctx, { since: "yesterday" });
    expect(requestQuery(fake.requests[0]).get("jql")).toContain(
      'updated >= "-1443m"'
    );
    expect(requestQuery(fake.requests[1]).get("jql")).toContain(
      'updated >= "-8m"'
    );
  });

  it("never starts the window after now when the cursor is ahead of the clock", async () => {
    const fake = routedHttp([searchRoute({ issues: [], isLast: true })]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), {
      since: "2026-10-04T12:30:00.000Z",
    });
    expect(requestQuery(fake.requests[0]).get("jql")).toContain(
      'updated >= "-3m"'
    );
    expect(result.cursor).toEqual({ since: "2026-10-04T12:00:00.000Z" });
  });

  it("continues from the newest change seen when the page is full", async () => {
    const issues = [
      searchIssue({
        id: "1",
        key: "PROJ-1",
        created: "2026-10-01T09:00:00.000+0000",
        updated: "2026-10-04T11:54:00.000+0000",
      }),
      searchIssue({
        id: "2",
        key: "PROJ-2",
        created: "2026-10-01T09:00:00.000+0000",
        updated: "2026-10-04T11:58:00.000+0000",
      }),
    ];
    const fake = routedHttp([
      searchRoute({ issues, nextPageToken: "token-2" }),
    ]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(result.cursor).toEqual({ since: "2026-10-04T11:58:00.000Z" });
  });

  it("moves at least a minute forward when a full page did not pass the cursor", async () => {
    const issues = [
      searchIssue({
        id: "1",
        key: "PROJ-1",
        created: "2026-10-01T09:00:00.000+0000",
        updated: "2026-10-04T11:54:00.000+0000",
      }),
    ];
    const fake = routedHttp([searchRoute({ issues, isLast: false })]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(result.cursor).toEqual({ since: "2026-10-04T11:56:00.000Z" });
  });

  it("processes at most 50 issues per poll", async () => {
    const issues = Array.from(
      { length: JIRA_POLL_MAX_ISSUES + 10 },
      (_, index) =>
        searchIssue({
          id: String(2000 + index),
          key: `PROJ-${index + 1}`,
          created: "2026-10-04T11:56:00.000+0000",
          updated: "2026-10-04T11:56:00.000+0000",
        })
    );
    const fake = routedHttp([searchRoute({ issues, isLast: true })]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    // Each issue was created assigned to the bot: assigned + conditions.
    expect(result.events).toHaveLength(JIRA_POLL_MAX_ISSUES * 2);
    expect(result.cursor).toEqual({ since: "2026-10-04T11:56:00.000Z" });
  });

  it("uses REST v2 search on Data Center and detects more results from total", async () => {
    const issues = [
      searchIssue({
        id: "3001",
        key: "OPS-7",
        created: "2026-10-01T09:00:00.000+0000",
        updated: "2026-10-04T11:58:00.000+0000",
        assignee: { name: "agentflow-bot", key: "JIRAUSER10100" },
        histories: [
          history({
            id: "30010",
            created: "2026-10-04T11:58:00.000+0000",
            author: { name: "bea", key: "JIRAUSER10001", displayName: "Bea" },
            items: [
              {
                field: "assignee",
                fieldtype: "jira",
                from: "bea",
                to: "agentflow-bot",
              },
            ],
          }),
        ],
      }),
    ];
    const fake = routedHttp([
      searchRoute(
        { startAt: 0, maxResults: 50, total: 75, issues },
        "/jira/rest/api/2/search"
      ),
    ]);
    const result = await pollJira(
      makeJiraContext({
        http: fake.http,
        config: dataCenterConfig(),
        account: DC_BOT_ACCOUNT,
      }),
      null
    );
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      "OPS-7:assignee:30010",
      "OPS-7:conditions:30010",
    ]);
    expect(result.cursor).toEqual({ since: "2026-10-04T11:58:00.000Z" });
  });

  it("fetches the changelog when the search did not include it", async () => {
    const issue = searchIssue({
      id: "1001",
      key: "PROJ-1",
      created: "2026-10-01T09:00:00.000+0000",
      updated: "2026-10-04T11:58:00.000+0000",
      withChangelog: false,
    });
    const fake = routedHttp([
      searchRoute({ issues: [issue], isLast: true }),
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/1001",
        respond: jsonResponse(200, {
          id: "1001",
          key: "PROJ-1",
          fields: {},
          changelog: {
            histories: [
              history({
                id: "h1",
                created: "2026-10-04T11:58:00.000+0000",
                items: [assigneeItem(null, BOT_ACCOUNT_ID)],
              }),
            ],
          },
        }),
      },
    ]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      "PROJ-1:assignee:h1",
      "PROJ-1:conditions:h1",
    ]);
    expect(requestQuery(fake.requests[1]).get("expand")).toBe("changelog");
  });

  it("loads the newest changelog page when Jira Cloud truncated a long history", async () => {
    const issue = searchIssue({
      id: "1001",
      key: "PROJ-1",
      created: "2026-01-01T09:00:00.000+0000",
      updated: "2026-10-04T11:58:00.000+0000",
      changelogTotal: 150,
      histories: [
        history({
          id: "h-ancient",
          created: "2026-01-01T09:00:00.000+0000",
          items: [assigneeItem(null, HUMAN_ACCOUNT_ID)],
        }),
      ],
    });
    const fake = routedHttp([
      searchRoute({ issues: [issue], isLast: true }),
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/issue/1001/changelog",
        respond: jsonResponse(200, {
          startAt: 50,
          maxResults: 100,
          total: 150,
          isLast: true,
          values: [
            history({
              id: "h-latest",
              created: "2026-10-04T11:58:00.000+0000",
              items: [assigneeItem(HUMAN_ACCOUNT_ID, BOT_ACCOUNT_ID)],
            }),
          ],
        }),
      },
    ]);
    const result = await pollJira(makeJiraContext({ http: fake.http }), null);
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      "PROJ-1:assignee:h-latest",
      "PROJ-1:conditions:h-latest",
    ]);
    expect(requestQuery(fake.requests[1]).get("startAt")).toBe("50");
  });

  it("judges a combination with the issue state right after each change", async () => {
    const issue = searchIssue({
      id: "1001",
      key: "PROJ-1",
      created: "2026-10-01T09:00:00.000+0000",
      updated: "2026-10-04T11:58:00.000+0000",
      labels: ["ai-ready"],
      histories: [
        history({
          id: "h-label",
          created: "2026-10-04T11:56:00.000+0000",
          items: [labelsItem("", "ai-ready")],
        }),
        history({
          id: "h-assign",
          created: "2026-10-04T11:58:00.000+0000",
          items: [assigneeItem(HUMAN_ACCOUNT_ID, BOT_ACCOUNT_ID)],
        }),
      ],
    });
    const fake = routedHttp([searchRoute({ issues: [issue], isLast: true })]);
    const ctx = makeJiraContext({ http: fake.http });

    const result = await pollJira(ctx, null);
    const conditions = result.events.filter(
      (event) => event.triggerType === JiraTriggerType.IssueConditions
    );
    const config = jiraIssueConditionsConfigSchema.parse({
      assigned: true,
      labels: ["ai-ready"],
    });

    expect(
      conditions.map((event) => [
        event.dedupKey,
        event.attributes[JiraEventAttribute.AssignedToBot],
        event.attributes[JiraEventAttribute.Labels],
        jiraIssueConditionsTrigger.matches(event, config, ctx.connection),
      ])
    ).toEqual([
      // The label came first, while the issue was assigned to someone else.
      ["PROJ-1:conditions:h-label", false, ["ai-ready"], false],
      // Assigning it to the bot completes the combination.
      ["PROJ-1:conditions:h-assign", true, ["ai-ready"], true],
    ]);
  });

  it("throws (so the poll records lastError and retries) when Jira fails", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: SEARCH_PATH,
        respond: jsonResponse(503, {}),
      },
    ]);
    await expect(
      pollJira(makeJiraContext({ http: fake.http }), null)
    ).rejects.toThrow("Jira search failed: Jira is unavailable (HTTP 503)");
  });

  it("throws when the bot account is unknown", async () => {
    const fake = routedHttp([]);
    await expect(
      pollJira(makeJiraContext({ http: fake.http, account: null }), null)
    ).rejects.toThrow(JIRA_POLL_BOT_UNKNOWN_ERROR);
    expect(fake.requests).toHaveLength(0);
  });

  it("uses the now of the context for the first window", async () => {
    const fake = routedHttp([searchRoute({ issues: [] })]);
    const result = await pollJira(
      makeJiraContext({ http: fake.http, now: NOW }),
      null
    );
    expect(result.cursor).toEqual({ since: "2026-10-04T11:59:00.000Z" });
  });
});
