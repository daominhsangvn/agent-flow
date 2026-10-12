import { createHash, createHmac } from "node:crypto";
import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { INBOUND_TOKEN_HEADER } from "../../../inbound-auth";
import type { InboundRequest } from "../../../types";
import {
  JIRA_AUTOMATION_EVENT_TYPE,
  JIRA_HUB_SIGNATURE_HEADER,
  JIRA_WEBHOOK_IDENTIFIER_HEADER,
  JiraEventAttribute,
  JiraIgnoredReason,
  JiraTriggerType,
  JiraWebhookEvent,
} from "../constants";
import { parseJiraRequest, verifyJiraRequest } from "../inbound";
import { jiraWebhookBodySchema } from "../schemas";
import { buildJiraSetupInstructions } from "../setup-instructions";
import {
  AUTOMATION_SAMPLE_ACCOUNT_ID,
  atlassianAutomationIssueDataSample,
} from "./automation-sample.test-fixtures";
import {
  assignedToBotWebhook,
  automationBody,
  BOT_USER,
  dataCenterAssignedWebhook,
  HUMAN_USER,
  issueCreatedWebhook,
  labelsAddedWebhook,
  WEBHOOK_TIMESTAMP,
} from "./jira.test-fixtures";
import {
  BOT_ACCOUNT_ID,
  CLOUD_BOT_ACCOUNT,
  CLOUD_SITE_URL,
  cloudConfig,
  DC_BOT_ACCOUNT,
  DC_SITE_URL,
  dataCenterConfig,
  HUMAN_ACCOUNT_ID,
  makeJiraContext,
  NOW,
  routedHttp,
} from "./jira.test-helpers";

const AUTOMATION_SAMPLE_BOT_ACCOUNT = {
  ...CLOUD_BOT_ACCOUNT,
  externalAccountId: AUTOMATION_SAMPLE_ACCOUNT_ID,
};

const SECRET = "jira-inbound-secret-0123456789abcdef";
const DELIVERY_ID = "b8f3e3a2-7c5d-4a1e-9e2f-0123456789ab";

function inboundRequest(
  body: unknown,
  headers: Record<string, string> = {}
): InboundRequest {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    rawBody,
    headers: new Headers(headers),
    url: new URL("https://api.example.com/webhooks/integrations/key-1"),
  };
}

function secretContext() {
  return {
    connection: {
      id: "conn-1",
      provider: IntegrationProviderKey.Jira,
      name: "Acme Jira",
      config: cloudConfig(),
      account: CLOUD_BOT_ACCOUNT,
    },
    inboundSecret: SECRET,
  };
}

function signed(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function parse(
  body: unknown,
  options: { dc?: boolean; noAccount?: boolean } = {}
) {
  const ctx = makeJiraContext({
    http: routedHttp([]).http,
    config: options.dc ? dataCenterConfig() : cloudConfig(),
    account: accountFor(options),
  });
  return parseJiraRequest(
    inboundRequest(body, { [JIRA_WEBHOOK_IDENTIFIER_HEADER]: DELIVERY_ID }),
    ctx
  );
}

function accountFor(options: { dc?: boolean; noAccount?: boolean }) {
  if (options.noAccount) {
    return null;
  }
  return options.dc ? DC_BOT_ACCOUNT : CLOUD_BOT_ACCOUNT;
}

describe("verifyJiraRequest", () => {
  it("accepts the X-Hub-Signature test vector from the inbound-auth research", () => {
    const secret = "It's a Secret to Everybody";
    const request = inboundRequest("Hello World!", {
      [JIRA_HUB_SIGNATURE_HEADER]:
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
    });
    expect(
      verifyJiraRequest(request, { ...secretContext(), inboundSecret: secret })
    ).toEqual({ ok: true });
  });

  it("accepts an admin webhook signed with the inbound secret", () => {
    const body = JSON.stringify(assignedToBotWebhook());
    const request = inboundRequest(body, {
      [JIRA_HUB_SIGNATURE_HEADER]: signed(body),
    });
    expect(verifyJiraRequest(request, secretContext())).toEqual({ ok: true });
  });

  it("rejects a wrong signature and never falls back to the token when a signature is present", () => {
    const body = JSON.stringify(assignedToBotWebhook());
    const request = inboundRequest(body, {
      [JIRA_HUB_SIGNATURE_HEADER]: signed(body, "another-secret"),
      [INBOUND_TOKEN_HEADER]: SECRET,
    });
    expect(verifyJiraRequest(request, secretContext())).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(assignedToBotWebhook());
    const request = inboundRequest(`${body} `, {
      [JIRA_HUB_SIGNATURE_HEADER]: signed(body),
    });
    expect(verifyJiraRequest(request, secretContext()).ok).toBe(false);
  });

  it("accepts the Automation static token header", () => {
    const request = inboundRequest(automationBody(), {
      [INBOUND_TOKEN_HEADER]: SECRET,
    });
    expect(verifyJiraRequest(request, secretContext())).toEqual({ ok: true });
  });

  it("rejects a wrong or missing token", () => {
    expect(
      verifyJiraRequest(
        inboundRequest(automationBody(), { [INBOUND_TOKEN_HEADER]: "nope" }),
        secretContext()
      )
    ).toEqual({ ok: false, reason: "token_mismatch" });
    expect(
      verifyJiraRequest(inboundRequest(automationBody()), secretContext())
    ).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });
});

describe("parseJiraRequest", () => {
  it("emits jira.issue_assigned for an issue assigned to the bot (Cloud)", async () => {
    const result = await parse(assignedToBotWebhook());
    expect(result).toEqual({
      deliveryId: DELIVERY_ID,
      eventType: JiraWebhookEvent.IssueUpdated,
      events: [
        {
          triggerType: JiraTriggerType.IssueAssigned,
          dedupKey: "PROJ-123:assignee:10234",
          occurredAt: new Date(WEBHOOK_TIMESTAMP),
          actor: { id: HUMAN_ACCOUNT_ID, displayName: "Bea Analyst" },
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
        },
      ],
    });
  });

  it("matches the bot through `to` when tmpToAccountId is absent", async () => {
    const payload = assignedToBotWebhook();
    const [item] = payload.changelog.items;
    const { tmpToAccountId: _ignored, ...withoutTmp } = item ?? {};
    const result = await parse({
      ...payload,
      changelog: { ...payload.changelog, items: [withoutTmp] },
    });
    expect(result.events.map((event) => event.dedupKey)).toEqual([
      "PROJ-123:assignee:10234",
    ]);
  });

  it("ignores an assignment to someone else", async () => {
    const result = await parse(assignedToBotWebhook({ to: HUMAN_ACCOUNT_ID }));
    expect(result).toEqual({
      deliveryId: DELIVERY_ID,
      eventType: JiraWebhookEvent.IssueUpdated,
      events: [],
      ignoredReason: JiraIgnoredReason.NoRelevantChange,
    });
  });

  it("drops events caused by the bot itself", async () => {
    const result = await parse(assignedToBotWebhook({ user: BOT_USER }));
    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(JiraIgnoredReason.CausedByBot);
  });

  it("acknowledges unsupported events with a reason", async () => {
    const result = await parse({
      timestamp: WEBHOOK_TIMESTAMP,
      webhookEvent: "worklog_created",
      user: HUMAN_USER,
      worklog: { id: "1" },
    });
    expect(result).toEqual({
      deliveryId: DELIVERY_ID,
      eventType: "worklog_created",
      events: [],
      ignoredReason: JiraIgnoredReason.UnsupportedEvent,
    });
  });

  it("reports invalid JSON and bodies without an issue", async () => {
    expect((await parse("{not json")).ignoredReason).toBe(
      JiraIgnoredReason.InvalidPayload
    );
    expect((await parse([1, 2])).ignoredReason).toBe(
      JiraIgnoredReason.InvalidPayload
    );
    const noIssue = await parse({
      webhookEvent: JiraWebhookEvent.IssueUpdated,
    });
    expect(noIssue.ignoredReason).toBe(JiraIgnoredReason.InvalidPayload);
    expect(noIssue.eventType).toBe(JiraWebhookEvent.IssueUpdated);
  });

  it("needs the bot account to recognise anything", async () => {
    const result = await parse(assignedToBotWebhook(), { noAccount: true });
    expect(result.ignoredReason).toBe(JiraIgnoredReason.BotAccountUnknown);
  });

  it("emits assigned and labeled events for an issue created with the bot and labels", async () => {
    const result = await parse(issueCreatedWebhook());
    expect(result.eventType).toBe(JiraWebhookEvent.IssueCreated);
    expect(
      result.events.map((event) => [
        event.triggerType,
        event.dedupKey,
        event.attributes.addedLabels,
      ])
    ).toEqual([
      [JiraTriggerType.IssueAssigned, "PROJ-123:created", undefined],
      [
        JiraTriggerType.IssueLabeled,
        "PROJ-123:created",
        ["ai-ready", "reports"],
      ],
    ]);
  });

  it("ignores a created issue that is unassigned and unlabeled", async () => {
    const result = await parse(
      issueCreatedWebhook({ assignee: null, labels: [] })
    );
    expect(result.ignoredReason).toBe(JiraIgnoredReason.NoRelevantChange);
  });

  it("emits jira.issue_labeled with only the added labels", async () => {
    const result = await parse(labelsAddedWebhook());
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.triggerType).toBe(JiraTriggerType.IssueLabeled);
    expect(result.events[0]?.dedupKey).toBe("PROJ-123:labels:10301");
    expect(
      result.events[0]?.attributes[JiraEventAttribute.AddedLabels]
    ).toEqual(["ai-ready"]);
  });

  it("treats a Jira Automation body as an assignment check against the assignee", async () => {
    const result = await parse(automationBody());
    expect(result.eventType).toBe(JIRA_AUTOMATION_EVENT_TYPE);
    expect(
      result.events.map((event) => [event.triggerType, event.dedupKey])
    ).toEqual([
      [
        JiraTriggerType.IssueAssigned,
        `PROJ-123:assignee:automation-${DELIVERY_ID}`,
      ],
    ]);
    const other = await parse(
      automationBody({
        assignee: { accountId: HUMAN_ACCOUNT_ID, displayName: "Bea" },
      })
    );
    expect(other.ignoredReason).toBe(JiraIgnoredReason.NoRelevantChange);
  });

  it("recognises the Data Center bot by user name", async () => {
    const result = await parse(dataCenterAssignedWebhook(), { dc: true });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.dedupKey).toBe("PROJ-123:assignee:20410");
    expect(result.events[0]?.item.url).toBe(`${DC_SITE_URL}/browse/PROJ-123`);
    expect(result.events[0]?.actor).toEqual({
      id: "JIRAUSER10001",
      displayName: "Bea Analyst",
    });
  });

  it("falls back to a body hash as delivery id and to now for a missing timestamp", async () => {
    const payload = { ...assignedToBotWebhook(), timestamp: undefined };
    const raw = JSON.stringify(payload);
    const ctx = makeJiraContext({ http: routedHttp([]).http });
    const result = await parseJiraRequest(inboundRequest(raw), ctx);
    expect(result.deliveryId).toBe(
      createHash("sha256").update(raw, "utf8").digest("hex")
    );
    expect(result.events[0]?.occurredAt).toEqual(NOW);
  });
});

describe("parseJiraRequest with Jira Automation bodies", () => {
  function parseSample(body: unknown) {
    const ctx = makeJiraContext({
      http: routedHttp([]).http,
      account: AUTOMATION_SAMPLE_BOT_ACCOUNT,
    });
    return parseJiraRequest(
      inboundRequest(body, { [JIRA_WEBHOOK_IDENTIFIER_HEADER]: DELIVERY_ID }),
      ctx
    );
  }

  it("emits jira.issue_assigned for Atlassian's documented 'Issue data (Jira format)' sample", async () => {
    const sample = atlassianAutomationIssueDataSample();

    const result = await parseSample({ ...sample, user: HUMAN_USER });

    expect(result).toEqual({
      deliveryId: DELIVERY_ID,
      eventType: JIRA_AUTOMATION_EVENT_TYPE,
      events: [
        {
          triggerType: JiraTriggerType.IssueAssigned,
          dedupKey: `SP-53:assignee:automation-${DELIVERY_ID}`,
          occurredAt: new Date(sample.timestamp),
          actor: { id: HUMAN_ACCOUNT_ID, displayName: "Bea Analyst" },
          item: {
            provider: IntegrationProviderKey.Jira,
            externalId: "11111",
            key: "SP-53",
            url: `${CLOUD_SITE_URL}/browse/SP-53`,
            title: "sample, Please ignore",
            container: "SP",
          },
          attributes: {
            [JiraEventAttribute.ProjectKey]: "SP",
            [JiraEventAttribute.IssueType]: "[System] Service request",
            [JiraEventAttribute.Labels]: ["sample-space"],
            [JiraEventAttribute.Status]: "Waiting for support",
          },
        },
      ],
    });
  });

  it("parses the sample as-is (the acting user is the assignee, so it was caused by the bot)", async () => {
    const result = await parseSample(atlassianAutomationIssueDataSample());

    expect(result.ignoredReason).toBe(JiraIgnoredReason.CausedByBot);
  });

  it("converts epoch-millisecond created/updated to ISO strings", () => {
    const parsed = jiraWebhookBodySchema.parse(
      atlassianAutomationIssueDataSample()
    );

    expect(parsed.issue.fields.created).toBe("2022-02-18T09:50:10.768Z");
    expect(parsed.issue.fields.updated).toBe("2022-02-25T10:34:15.778Z");
    expect(parsed.issue.renderedFields).toBeNull();
    expect(parsed.issue.changelog?.histories).toBeNull();
  });

  it("degrades unexpected non-essential values instead of dropping the delivery", async () => {
    const sample = atlassianAutomationIssueDataSample();
    const result = await parseSample({
      ...sample,
      user: { ...HUMAN_USER, active: "yes", timeZone: 5 },
      changelog: "none",
      issue: {
        ...sample.issue,
        renderedFields: "<p>html</p>",
        names: ["Summary"],
        changelog: { histories: [{ created: 1 }], total: "0" },
        fields: {
          ...sample.issue.fields,
          created: "not a date",
          updated: Number.MAX_VALUE,
          summary: 42,
          labels: "sample-space",
          status: "Waiting for support",
          priority: 3,
          project: ["SP"],
          attachment: { id: 1 },
          reporter: "User Name",
          creator: 7,
        },
      },
    });

    expect(result.ignoredReason).toBeUndefined();
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event?.dedupKey).toBe(`SP-53:assignee:automation-${DELIVERY_ID}`);
    expect(event?.actor).toEqual({
      id: HUMAN_ACCOUNT_ID,
      displayName: "Bea Analyst",
    });
    expect(event?.item).toMatchObject({ key: "SP-53", title: null });
    expect(event?.attributes).toEqual({
      [JiraEventAttribute.ProjectKey]: "SP",
      [JiraEventAttribute.IssueType]: "[System] Service request",
      [JiraEventAttribute.Labels]: [],
      [JiraEventAttribute.Status]: null,
    });
  });

  it("still drops a body whose issue has no key", async () => {
    const sample = atlassianAutomationIssueDataSample();
    const { key: _key, ...issueWithoutKey } = sample.issue;

    const result = await parseSample({
      ...sample,
      user: HUMAN_USER,
      issue: issueWithoutKey,
    });

    expect(result.ignoredReason).toBe(JiraIgnoredReason.InvalidPayload);
  });
});

describe("buildJiraSetupInstructions", () => {
  const base = {
    connection: {
      id: "conn-1",
      provider: IntegrationProviderKey.Jira,
      name: "Acme Jira",
      config: cloudConfig(),
      account: CLOUD_BOT_ACCOUNT,
    },
    inboundSecret: SECRET,
    inboundUrl: "https://agentflow.example.com/webhooks/integrations/key-1",
  };

  it("explains the admin webhook and the Automation rule for webhook mode", () => {
    const markdown = buildJiraSetupInstructions({
      ...base,
      deliveryMode: IntegrationDeliveryMode.Webhook,
    });
    expect(markdown).toContain(base.inboundUrl);
    expect(markdown).toContain(`**Secret**: \`${SECRET}\``);
    expect(markdown).toContain(`assignee = "${BOT_ACCOUNT_ID}"`);
    expect(markdown).toContain("Settings (⚙) > System > WebHooks");
    expect(markdown).toContain("Work item assigned");
    expect(markdown).toContain("Work item data (Jira format)");
    expect(markdown).toContain(
      `Header \`X-AgentFlow-Token\` with the value \`${SECRET}\``
    );
    expect(markdown).toContain("port **443**");
    expect(markdown).toContain("**Poll**");
  });

  it("uses the Data Center user name in the JQL filter", () => {
    const markdown = buildJiraSetupInstructions({
      ...base,
      connection: {
        ...base.connection,
        config: dataCenterConfig(),
        account: DC_BOT_ACCOUNT,
      },
      deliveryMode: IntegrationDeliveryMode.Webhook,
    });
    expect(markdown).toContain('assignee = "agentflow-bot"');
    expect(markdown).not.toContain("port **443**");
  });

  it("asks to test the connection when the bot is unknown", () => {
    const markdown = buildJiraSetupInstructions({
      ...base,
      connection: { ...base.connection, account: null },
      deliveryMode: IntegrationDeliveryMode.Webhook,
    });
    expect(markdown).toContain("Test the connection");
  });

  it("explains that polling covers assignments only", () => {
    const markdown = buildJiraSetupInstructions({
      ...base,
      deliveryMode: IntegrationDeliveryMode.Poll,
    });
    expect(markdown).toContain("Issue labeled");
    expect(markdown).toContain("**Webhook** delivery");
    expect(markdown).not.toContain(SECRET);
  });

  it("describes action-only connections", () => {
    const markdown = buildJiraSetupInstructions({
      ...base,
      deliveryMode: IntegrationDeliveryMode.None,
    });
    expect(markdown).toContain("actions only");
  });
});
