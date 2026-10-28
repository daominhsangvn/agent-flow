import { describe, expect, it } from "vitest";
import type { InboundRequest } from "../../../types";
import {
  JIRA_WEBHOOK_IDENTIFIER_HEADER,
  JiraEventAttribute,
  JiraIgnoredReason,
  JiraSignalType,
  JiraTriggerType,
} from "../constants";
import { parseJiraRequest } from "../inbound";
import { jiraAnswerReply } from "../issue-events";
import {
  HUMAN_USER,
  WEBHOOK_TIMESTAMP,
  webhookIssue,
} from "./jira.test-fixtures";
import {
  BOT_ACCOUNT_ID,
  CLOUD_BOT_ACCOUNT,
  cloudConfig,
  makeJiraContext,
  routedHttp,
} from "./jira.test-helpers";

const DELIVERY_ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2e";
const QUESTION_COMMENT_ID = "10800";

describe("jira.comment_reply webhooks", () => {
  it("turns a reply in a comment thread into a reply event", async () => {
    const result = await parse(replyWebhook("1a, 2b"));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      triggerType: JiraSignalType.CommentReply,
      dedupKey: "PROJ-123:reply:10900",
      actor: { id: HUMAN_USER.accountId },
      attributes: { [JiraEventAttribute.RepliedTo]: QUESTION_COMMENT_ID },
    });
    expect(jiraAnswerReply(result.events[0]!)).toBe(QUESTION_COMMENT_ID);
  });

  it("puts the reply event before the mention events of a reply that mentions the bot", async () => {
    // Jira's Reply mentions the author of the replied comment: the bot.
    const result = await parse(
      replyWebhook(`[~accountid:${BOT_ACCOUNT_ID}] 1a, 2b`)
    );

    expect(result.events.map((event) => event.triggerType)).toEqual([
      JiraSignalType.CommentReply,
      JiraTriggerType.IssueMentioned,
      JiraTriggerType.IssueConditions,
    ]);
  });

  it("does not take an edited reply as a new answer", async () => {
    const result = await parse(
      replyWebhook("1a, 2c", { event: "comment_updated" })
    );

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(JiraIgnoredReason.NoRelevantChange);
  });

  it("answers nothing for an event that is no reply", () => {
    expect(
      jiraAnswerReply({
        triggerType: JiraTriggerType.IssueConditions,
        dedupKey: "PROJ-123:conditions:comment-10900",
        occurredAt: new Date(),
        actor: null,
        item: {
          provider: "jira",
          externalId: "10042",
          key: "PROJ-123",
          url: null,
          title: null,
          container: "PROJ",
        },
        attributes: { [JiraEventAttribute.RepliedTo]: QUESTION_COMMENT_ID },
      })
    ).toBeNull();
  });
});

function parse(body: unknown) {
  const request: InboundRequest = {
    rawBody: JSON.stringify(body),
    headers: new Headers({ [JIRA_WEBHOOK_IDENTIFIER_HEADER]: DELIVERY_ID }),
    url: new URL("https://api.example.com/webhooks/integrations/key-1"),
  };
  const ctx = makeJiraContext({
    http: routedHttp([]).http,
    config: cloudConfig(),
    account: CLOUD_BOT_ACCOUNT,
  });
  return parseJiraRequest(request, ctx);
}

/** Jira Cloud `comment_created` webhook of a reply to comment 10800. */
function replyWebhook(body: string, overrides: { event?: string } = {}) {
  return {
    timestamp: WEBHOOK_TIMESTAMP,
    webhookEvent: overrides.event ?? "comment_created",
    comment: {
      id: "10900",
      parentId: Number(QUESTION_COMMENT_ID),
      author: HUMAN_USER,
      body,
      updateAuthor: HUMAN_USER,
      created: "2026-10-04T11:59:00.000+0000",
      updated: "2026-10-04T11:59:00.000+0000",
    },
    issue: webhookIssue({ assignee: null }),
  };
}
