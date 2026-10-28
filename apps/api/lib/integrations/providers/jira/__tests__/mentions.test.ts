import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { HttpMethod, type InboundRequest } from "../../../types";
import {
  JIRA_WEBHOOK_IDENTIFIER_HEADER,
  JiraEventAttribute,
  JiraIgnoredReason,
  JiraTriggerType,
} from "../constants";
import { parseJiraRequest } from "../inbound";
import { descriptionMentionsBot, mentionsJiraBot } from "../mentions";
import { jiraIssueMentionedTrigger } from "../triggers";
import {
  BOT_USER,
  HUMAN_USER,
  WEBHOOK_TIMESTAMP,
  webhookIssue,
} from "./jira.test-fixtures";
import {
  BOT_ACCOUNT_ID,
  BOT_DC_NAME,
  CLOUD_BOT_ACCOUNT,
  cloudConfig,
  DC_BOT_ACCOUNT,
  type FakeHttp,
  HUMAN_ACCOUNT_ID,
  jsonResponse,
  makeJiraContext,
  requestQuery,
  routedHttp,
} from "./jira.test-helpers";

const DELIVERY_ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const ISSUE_PATH = "/rest/api/3/issue/10042";

function parse(body: unknown, fake: FakeHttp = routedHttp([])) {
  const request: InboundRequest = {
    rawBody: JSON.stringify(body),
    headers: new Headers({ [JIRA_WEBHOOK_IDENTIFIER_HEADER]: DELIVERY_ID }),
    url: new URL("https://api.example.com/webhooks/integrations/key-1"),
  };
  const ctx = makeJiraContext({
    http: fake.http,
    config: cloudConfig(),
    account: CLOUD_BOT_ACCOUNT,
  });
  return parseJiraRequest(request, ctx);
}

/** GET /rest/api/3/issue/10042?fields=… as the comment trigger reads it. */
function commentedIssue(fields: Record<string, unknown>) {
  return {
    id: "10042",
    key: "PROJ-123",
    fields: {
      summary: "Add CSV export to the reports page",
      issuetype: { name: "Story" },
      project: { key: "PROJ" },
      status: { name: "In Progress" },
      ...fields,
    },
  };
}

/** Jira Cloud `comment_created` admin webhook (REST v2 shape, wiki markup body). */
function commentWebhook(
  body: unknown,
  overrides: { author?: unknown; event?: string } = {}
) {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: overrides.event ?? "comment_created",
    comment: {
      self: "https://acme.atlassian.net/rest/api/2/issue/10042/comment/10900",
      id: "10900",
      author: overrides.author ?? HUMAN_USER,
      body,
      updateAuthor: overrides.author ?? HUMAN_USER,
      created: "2026-10-04T11:59:00.000+0000",
      updated: "2026-10-04T11:59:00.000+0000",
    },
    issue: webhookIssue({ assignee: null }),
  };
}

describe("mentionsJiraBot", () => {
  it("finds Cloud wiki mentions, Data Center user names and ADF mention nodes", () => {
    expect(
      mentionsJiraBot(
        `Hi [~accountid:${BOT_ACCOUNT_ID}], please take this one`,
        CLOUD_BOT_ACCOUNT
      )
    ).toBe(true);
    expect(
      mentionsJiraBot(`[~${BOT_DC_NAME}] can you look?`, DC_BOT_ACCOUNT)
    ).toBe(true);
    expect(
      mentionsJiraBot(
        {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Ping " },
                {
                  type: "mention",
                  attrs: { id: BOT_ACCOUNT_ID, text: "@AgentFlow Bot" },
                },
              ],
            },
          ],
        },
        CLOUD_BOT_ACCOUNT
      )
    ).toBe(true);
  });

  it("ignores mentions of other people and plain text", () => {
    expect(
      mentionsJiraBot(`[~accountid:${HUMAN_ACCOUNT_ID}]`, CLOUD_BOT_ACCOUNT)
    ).toBe(false);
    expect(mentionsJiraBot("@AgentFlow Bot", CLOUD_BOT_ACCOUNT)).toBe(false);
    expect(mentionsJiraBot(null, CLOUD_BOT_ACCOUNT)).toBe(false);
  });

  it("flags a description change only when the mention is new", () => {
    const item = (from: string, to: string) => ({
      field: "description",
      fieldId: "description",
      fromString: from,
      toString: to,
      fromText: from,
      toText: to,
      from: null,
      to: null,
    });
    const mention = `[~accountid:${BOT_ACCOUNT_ID}]`;

    expect(
      descriptionMentionsBot([item("old", `old ${mention}`)], CLOUD_BOT_ACCOUNT)
    ).toBe(true);
    expect(
      descriptionMentionsBot(
        [item(`was ${mention}`, `still ${mention}`)],
        CLOUD_BOT_ACCOUNT
      )
    ).toBe(false);
  });
});

describe("jira.issue_mentioned webhooks", () => {
  it("starts on a comment that mentions the bot", async () => {
    const result = await parse(
      commentWebhook(`[~accountid:${BOT_ACCOUNT_ID}] please implement this`)
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      triggerType: JiraTriggerType.IssueMentioned,
      dedupKey: "PROJ-123:mention:comment-10900",
      item: { provider: IntegrationProviderKey.Jira, key: "PROJ-123" },
      actor: { id: HUMAN_USER.accountId },
    });
    expect(result.events[1]).toMatchObject({
      triggerType: JiraTriggerType.IssueConditions,
      dedupKey: "PROJ-123:conditions:comment-10900",
      attributes: {
        [JiraEventAttribute.Mentioned]: true,
        [JiraEventAttribute.BecameAssigned]: false,
        [JiraEventAttribute.AddedLabels]: [],
      },
    });
  });

  it("reads the commented issue, whose webhook lacks the labels, for the filters", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: ISSUE_PATH,
        respond: jsonResponse(
          200,
          commentedIssue({
            labels: ["ai-ready"],
            assignee: { accountId: BOT_ACCOUNT_ID },
          })
        ),
      },
    ]);
    const payload = commentWebhook(`[~accountid:${BOT_ACCOUNT_ID}] go`);
    // A comment webhook's issue carries only a few fields.
    const { labels: _labels, ...trimmedFields } = payload.issue.fields;

    const result = await parse(
      { ...payload, issue: { ...payload.issue, fields: trimmedFields } },
      fake
    );

    expect(fake.requests).toHaveLength(1);
    expect(requestQuery(fake.requests[0]).get("fields")).toContain("labels");
    expect(result.events.map((event) => event.attributes)).toEqual([
      expect.objectContaining({
        [JiraEventAttribute.Labels]: ["ai-ready"],
        [JiraEventAttribute.Status]: "In Progress",
      }),
      expect.objectContaining({
        [JiraEventAttribute.Labels]: ["ai-ready"],
        [JiraEventAttribute.AssignedToBot]: true,
        [JiraEventAttribute.Mentioned]: true,
      }),
    ]);
  });

  it("keeps the mention with the webhook's fields when the issue cannot be read", async () => {
    const result = await parse(
      commentWebhook(`[~accountid:${BOT_ACCOUNT_ID}] go`),
      routedHttp([
        {
          method: HttpMethod.Get,
          path: ISSUE_PATH,
          respond: jsonResponse(503, { errorMessages: ["down"] }),
        },
      ])
    );

    expect(result.events.map((event) => event.triggerType)).toEqual([
      JiraTriggerType.IssueMentioned,
      JiraTriggerType.IssueConditions,
    ]);
    expect(result.events[0]?.attributes[JiraEventAttribute.Labels]).toEqual([
      "ai-ready",
      "reports",
    ]);
  });

  it("does not read the issue for a comment without a bot mention", async () => {
    const fake = routedHttp([]);

    await parse(commentWebhook("Looks good"), fake);

    expect(fake.requests).toEqual([]);
  });

  it("ignores comments without a bot mention and comments by the bot", async () => {
    const plain = await parse(commentWebhook("Looks good"));
    const byBot = await parse(
      commentWebhook(`[~accountid:${BOT_ACCOUNT_ID}] note to self`, {
        author: BOT_USER,
        event: "comment_updated",
      })
    );

    expect(plain.ignoredReason).toBe(JiraIgnoredReason.NoRelevantChange);
    expect(byBot.ignoredReason).toBe(JiraIgnoredReason.CausedByBot);
  });

  it("starts on an issue created with a description that mentions the bot", async () => {
    const issue = webhookIssue({ assignee: null, labels: [] });
    issue.fields.description = `Ask [~accountid:${BOT_ACCOUNT_ID}] to build it`;

    const result = await parse({
      timestamp: WEBHOOK_TIMESTAMP,
      webhookEvent: "jira:issue_created",
      user: HUMAN_USER,
      issue,
    });

    expect(result.events.map((event) => event.triggerType)).toEqual([
      JiraTriggerType.IssueMentioned,
      JiraTriggerType.IssueConditions,
    ]);
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      "PROJ-123:created",
      "PROJ-123:conditions:created",
    ]);
  });

  it("uses the assigned trigger's filters", () => {
    const config = jiraIssueMentionedTrigger.configSchema.parse({
      projectKeys: ["OTHER"],
    });
    const event = {
      triggerType: JiraTriggerType.IssueMentioned,
      dedupKey: "PROJ-123:mention:comment-1",
      occurredAt: new Date(WEBHOOK_TIMESTAMP),
      actor: null,
      item: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10042",
        key: "PROJ-123",
        url: null,
        title: null,
        container: "PROJ",
      },
      attributes: { projectKey: "PROJ", issueType: "Story", labels: [] },
    };
    const connection = makeJiraContext({
      http: routedHttp([]).http,
      config: cloudConfig(),
      account: CLOUD_BOT_ACCOUNT,
    }).connection;

    expect(jiraIssueMentionedTrigger.matches(event, config, connection)).toBe(
      false
    );
  });
});
