import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type InboundRequest,
  RetryableSourceError,
  ValidateConnectionReason,
} from "../../../types";
import {
  TEAMS_BOT_INCOMPLETE_ERROR,
  TEAMS_NOTHING_CONFIGURED_ERROR,
} from "../connection";
import {
  TeamsEventAttribute,
  TeamsExtra,
  TeamsIgnoredReason,
  TeamsSignalType,
  TeamsTriggerType,
} from "../constants";
import { clearEntraTokenCache } from "../entra-token";
import { parseTeamsRequest } from "../inbound";
import { TeamsActionType } from "../post-message-action";
import { microsoftTeamsProvider } from "../provider";
import { teamsReplyConfigSchema } from "../reply-action";
import { fetchTeamsThread, TEAMS_THREAD_SECTION_TITLE } from "../source";
import { decodeThreadExternalId, parseChannelReference } from "../thread-ref";
import {
  teamsBotMentionedConfigSchema,
  teamsBotMentionedTrigger,
} from "../trigger";
import {
  ACTION_RUN_ID,
  BOT_APP_ID,
  BOT_TENANT_ID,
  fakeHttp,
  httpResponse,
  jsonResponse,
  makeRunSnapshot,
  makeTeamsContext,
  renderer,
  routedHttp,
  tokenRoute,
} from "./teams.test-helpers";

const CHANNEL_ID = "19:general0123@thread.tacv2";
const TEAM_GROUP_ID = "eeeeeeee-1111-4222-8333-ffffffffffff";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const ROOT_ID = "1700000000001";
const REPLY_ID = "1700000000009";
const BOT_ID = `28:${BOT_APP_ID}`;

beforeEach(() => {
  clearEntraTokenCache();
});

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: REPLY_ID,
    timestamp: "2026-10-04T11:59:00.000Z",
    channelId: "msteams",
    serviceUrl: SERVICE_URL,
    from: { id: "29:user-1", name: "Lan Nguyen", aadObjectId: "user-aad-1" },
    conversation: {
      id: `${CHANNEL_ID};messageid=${ROOT_ID}`,
      conversationType: "channel",
      tenantId: BOT_TENANT_ID,
    },
    text: "<at>AgentFlow</at> please add CSV export to the report page",
    entities: [
      {
        type: "mention",
        text: "<at>AgentFlow</at>",
        mentioned: { id: BOT_ID, name: "AgentFlow" },
      },
    ],
    channelData: {
      tenant: { id: BOT_TENANT_ID },
      team: { id: "19:team@thread.tacv2", aadGroupId: TEAM_GROUP_ID },
      channel: { id: CHANNEL_ID },
    },
    ...overrides,
  };
}

function inbound(body: unknown): InboundRequest {
  return {
    rawBody: JSON.stringify(body),
    headers: new Headers(),
    url: new URL("https://api.example.com/webhooks/integrations/key"),
  };
}

async function parse(body: unknown) {
  return await parseTeamsRequest(
    inbound(body),
    makeTeamsContext({ http: fakeHttp().http, bot: true })
  );
}

describe("parseTeamsRequest", () => {
  it("turns a mention in a thread reply into a bot_mentioned event for the thread", async () => {
    const result = await parse(activity());

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event).toMatchObject({
      triggerType: TeamsTriggerType.BotMentioned,
      dedupKey: `${CHANNEL_ID};messageid=${ROOT_ID}:mention:${REPLY_ID}`,
      actor: { id: "user-aad-1", displayName: "Lan Nguyen" },
      item: {
        provider: IntegrationProviderKey.MicrosoftTeams,
        title: "please add CSV export to the report page",
        container: CHANNEL_ID,
      },
      attributes: {
        [TeamsEventAttribute.ChannelId]: CHANNEL_ID,
        [TeamsEventAttribute.TeamId]: TEAM_GROUP_ID,
        [TeamsEventAttribute.Reply]: true,
      },
      extras: {
        [TeamsExtra.ServiceUrl]: SERVICE_URL,
        [TeamsExtra.ConversationId]: `${CHANNEL_ID};messageid=${ROOT_ID}`,
        [TeamsExtra.RequesterId]: "29:user-1",
        [TeamsExtra.RequesterName]: "Lan Nguyen",
      },
    });
    expect(decodeThreadExternalId(event?.item.externalId ?? "")).toEqual({
      teamId: TEAM_GROUP_ID,
      channelId: CHANNEL_ID,
      rootMessageId: ROOT_ID,
      messageId: REPLY_ID,
    });
  });

  it("gives every mention in one thread the same item key", async () => {
    const first = await parse(activity());
    const second = await parse(activity({ id: "1700000000020" }));
    const newPost = await parse(
      activity({
        id: ROOT_ID,
        conversation: { ...activity().conversation, id: CHANNEL_ID },
      })
    );

    expect(second.events[0]?.item.key).toBe(first.events[0]?.item.key);
    expect(second.events[0]?.dedupKey).not.toBe(first.events[0]?.dedupKey);
    expect(newPost.events[0]?.item.key).toBe(first.events[0]?.item.key);
    expect(newPost.events[0]?.attributes[TeamsEventAttribute.Reply]).toBe(
      false
    );
  });

  it("reports a reply in a thread without a mention for an orchestrator already in the thread", async () => {
    const parsed = await parse(
      activity({ entities: [], text: "and for part-timers?" })
    );

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      triggerType: TeamsSignalType.ThreadReply,
      message: {
        id: REPLY_ID,
        parentId: ROOT_ID,
        text: "and for part-timers?",
      },
    });
    expect(parsed.events[0]?.dedupKey).toContain(":reply:");
  });

  it.each([
    [
      "a new post that does not mention the bot",
      {
        entities: [],
        conversation: { ...activity().conversation, id: CHANNEL_ID },
      },
      TeamsIgnoredReason.NotMentioned,
    ],
    [
      "the bot's own message",
      { from: { id: BOT_ID } },
      TeamsIgnoredReason.CausedByBot,
    ],
    [
      "a group chat",
      {
        conversation: {
          id: "19:chat@thread.v2",
          conversationType: "groupChat",
        },
      },
      TeamsIgnoredReason.NotAChannel,
    ],
    [
      "another tenant",
      {
        channelData: {
          ...activity().channelData,
          tenant: { id: "99999999-1111-4222-8333-999999999999" },
        },
      },
      TeamsIgnoredReason.OtherTenant,
    ],
    [
      "an install",
      { type: "conversationUpdate" },
      TeamsIgnoredReason.UnsupportedActivity,
    ],
  ])("ignores %s", async (_name, overrides, reason) => {
    const result = await parse(activity(overrides));

    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toBe(reason);
  });

  it("reads the team's group id from the Bot Connector when the activity lacks it", async () => {
    const { http, requests } = routedHttp(tokenRoute, (request) =>
      request.url.endsWith("/v3/teams/19%3Ateam%40thread.tacv2")
        ? jsonResponse({ aadGroupId: TEAM_GROUP_ID })
        : undefined
    );
    const result = await parseTeamsRequest(
      inbound(
        activity({
          channelData: {
            ...activity().channelData,
            team: { id: "19:team@thread.tacv2" },
          },
        })
      ),
      makeTeamsContext({ http, bot: true })
    );

    expect(result.events[0]?.attributes[TeamsEventAttribute.TeamId]).toBe(
      TEAM_GROUP_ID
    );
    expect(requests.at(-1)?.headers?.authorization).toBe(
      "Bearer token-for-api.botframework.com"
    );
  });
});

describe("microsoft_teams.bot_mentioned trigger", () => {
  it("filters by channel, empty meaning every channel", async () => {
    const event = (await parse(activity())).events[0];
    if (!event) {
      throw new Error("no event");
    }
    const runtime = makeTeamsContext({ http: fakeHttp().http }).connection;
    const matches = (channels: string[]) =>
      teamsBotMentionedTrigger.matches(
        event,
        teamsBotMentionedConfigSchema.parse({ channels }),
        runtime
      );

    expect(matches([])).toBe(true);
    expect(matches([CHANNEL_ID.toUpperCase()])).toBe(true);
    expect(matches(["19:other@thread.tacv2"])).toBe(false);
  });
});

describe("parseChannelReference", () => {
  it("reads channel and message links and ids", () => {
    expect(
      parseChannelReference(
        "https://teams.microsoft.com/l/channel/19%3AGeneral0123%40thread.tacv2/General?groupId=x&tenantId=y"
      )
    ).toEqual({ ok: true, value: CHANNEL_ID });
    expect(
      parseChannelReference(
        `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL_ID)}/${ROOT_ID}`
      )
    ).toEqual({ ok: true, value: CHANNEL_ID });
    expect(parseChannelReference("General").ok).toBe(false);
    expect(
      parseChannelReference(
        "https://evil.example/l/channel/19%3Aa%40thread.tacv2/x"
      ).ok
    ).toBe(false);
  });
});

describe("fetchTeamsThread", () => {
  const ref = `${TEAM_GROUP_ID}|${CHANNEL_ID}|${ROOT_ID}|${REPLY_ID}`;
  const itemRef = {
    provider: IntegrationProviderKey.MicrosoftTeams,
    externalId: ref,
    key: "teams-abc",
    url: null,
    title: null,
    container: CHANNEL_ID,
  };
  const root = {
    id: ROOT_ID,
    createdDateTime: "2026-10-04T10:00:00Z",
    subject: "Reports",
    body: { contentType: "html", content: "<p>The report page is slow.</p>" },
    from: { user: { displayName: "Minh Tran" } },
  };
  const botMention = {
    id: 0,
    mentionText: "AgentFlow",
    mentioned: { application: { id: BOT_APP_ID, displayName: "AgentFlow" } },
  };
  const replies = [
    {
      id: REPLY_ID,
      createdDateTime: "2026-10-04T11:00:00Z",
      body: {
        contentType: "html",
        content:
          '<p><at id="0">AgentFlow</at> please add CSV export, <at id="1">Minh</at> agrees</p>',
      },
      from: { user: { displayName: "Lan Nguyen" } },
      mentions: [
        botMention,
        { id: 1, mentionText: "Minh", mentioned: { user: { id: "u2" } } },
      ],
    },
    {
      id: "1700000000005",
      createdDateTime: "2026-10-04T10:30:00Z",
      body: { contentType: "html", content: "<p>Exports would help.</p>" },
      from: { user: { displayName: "Minh Tran" } },
    },
    {
      id: "1700000000006",
      createdDateTime: "2026-10-04T10:40:00Z",
      deletedDateTime: "2026-10-04T10:41:00Z",
      body: { contentType: "html", content: "" },
    },
  ];

  function graphHttp(repliesStatus = 200) {
    return routedHttp(tokenRoute, (request) => {
      if (!request.url.startsWith("https://graph.microsoft.com/v1.0/teams/")) {
        return undefined;
      }
      if (request.url.includes("/replies")) {
        return repliesStatus === 200
          ? jsonResponse({ value: replies })
          : httpResponse({ status: repliesStatus });
      }
      return jsonResponse(root);
    });
  }

  it("makes the mention the request and the whole thread its context", async () => {
    const { http, requests } = graphHttp();

    const item = await fetchTeamsThread(
      makeTeamsContext({ http, bot: true }),
      itemRef
    );

    expect(item.title).toBe("please add CSV export, @Minh agrees");
    expect(item.bodyMarkdown).toBe("please add CSV export, @Minh agrees");
    expect(item.reporter).toBe("Lan Nguyen");
    const thread = item.sections.find(
      (section) => section.title === TEAMS_THREAD_SECTION_TITLE
    )?.markdown;
    expect(thread).toContain("Subject: **Reports**");
    // Oldest first, deleted replies left out.
    expect(thread?.indexOf("The report page is slow.")).toBeLessThan(
      thread?.indexOf("Exports would help.") ?? 0
    );
    expect(thread?.indexOf("Exports would help.")).toBeLessThan(
      thread?.indexOf("please add CSV export") ?? 0
    );
    expect(thread).toContain("the request to the bot");
    expect(requests.at(-1)?.headers?.authorization).toBe(
      "Bearer token-for-graph.microsoft.com"
    );
  });

  it("reports a missing Graph permission and retries throttling", async () => {
    await expect(
      fetchTeamsThread(
        makeTeamsContext({ http: graphHttp(403).http, bot: true }),
        itemRef
      )
    ).rejects.toThrow("ChannelMessage.Read.Group");
    await expect(
      fetchTeamsThread(
        makeTeamsContext({ http: graphHttp(429).http, bot: true }),
        itemRef
      )
    ).rejects.toBeInstanceOf(RetryableSourceError);
  });
});

describe("microsoft_teams.reply", () => {
  const action = microsoftTeamsProvider.actions.find(
    (candidate) => candidate.key === TeamsActionType.Reply
  );
  if (!action) {
    throw new Error("reply action missing");
  }
  const teamsRun = makeRunSnapshot({
    source: {
      provider: IntegrationProviderKey.MicrosoftTeams,
      externalId: "x",
      key: "teams-abc",
      url: null,
      title: "CSV export",
      container: CHANNEL_ID,
    },
    sourceExtras: {
      [TeamsExtra.ServiceUrl]: SERVICE_URL,
      [TeamsExtra.ConversationId]: `${CHANNEL_ID};messageid=${ROOT_ID}`,
      [TeamsExtra.RequesterId]: "29:user-1",
      [TeamsExtra.RequesterName]: "Lan Nguyen",
    },
  });

  function replyContext(run = teamsRun, extras: { serviceUrl?: string } = {}) {
    const sent = routedHttp(tokenRoute, (request) =>
      request.url.includes("/v3/conversations/")
        ? jsonResponse({ id: "1700000000099" }, 201)
        : undefined
    );
    const snapshot = extras.serviceUrl
      ? {
          ...run,
          sourceExtras: {
            ...run.sourceExtras,
            [TeamsExtra.ServiceUrl]: extras.serviceUrl,
          },
        }
      : run;
    return {
      sent,
      context: {
        ...makeTeamsContext({ http: sent.http, bot: true }),
        config: teamsReplyConfigSchema.parse({}),
        run: snapshot,
        actionRunId: ACTION_RUN_ID,
        attempt: 1,
        render: renderer(snapshot),
      },
    };
  }

  it("answers in the thread and mentions who asked", async () => {
    const { context, sent } = replyContext();

    const result = await action.execute(context);

    expect(result).toMatchObject({
      status: WorkflowActionRunStatus.Succeeded,
      externalRef: "1700000000099",
    });
    const post = sent.requests.at(-1);
    expect(post?.url).toBe(
      `https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(`${CHANNEL_ID};messageid=${ROOT_ID}`)}/activities`
    );
    expect(post?.headers?.authorization).toBe(
      "Bearer token-for-api.botframework.com"
    );
    expect(post?.body).toMatchObject({
      type: "message",
      text: `<at>Lan Nguyen</at> ${teamsRun.summaryMarkdown}`,
      entities: [{ mentioned: { id: "29:user-1", name: "Lan Nguyen" } }],
    });
  });

  it("never sends the bot's token to a host that is not Teams", async () => {
    const { context, sent } = replyContext(teamsRun, {
      serviceUrl: "https://evil.example/",
    });

    const result = await action.execute(context);

    expect(result.status).toBe(WorkflowActionRunStatus.Skipped);
    expect(sent.requests).toEqual([]);
  });

  it("is skipped for runs that did not come from Teams", async () => {
    const { context, sent } = replyContext(makeRunSnapshot());

    expect((await action.execute(context)).status).toBe(
      WorkflowActionRunStatus.Skipped
    );
    expect(sent.requests).toEqual([]);
  });
});

describe("validateTeamsConnection with a bot", () => {
  const validate = microsoftTeamsProvider.connection.validate;

  it("signs the bot in and records it as the account", async () => {
    const { http, requests } = routedHttp(tokenRoute);

    const result = await validate(
      makeTeamsContext({ http, bot: true, webhookUrl: null }),
      ValidateConnectionReason.Save
    );

    expect(result).toEqual({
      ok: true,
      account: expect.objectContaining({ externalAccountId: BOT_ID }),
    });
    expect(requests.map((request) => request.url)).toEqual([
      `https://login.microsoftonline.com/${BOT_TENANT_ID}/oauth2/v2.0/token`,
    ]);
  });

  it("needs a webhook or a complete bot", async () => {
    const http = fakeHttp().http;
    const empty = makeTeamsContext({ http, webhookUrl: null });
    const partial = makeTeamsContext({ http, webhookUrl: null });
    partial.connection.config = { appId: BOT_APP_ID };

    expect(await validate(empty, ValidateConnectionReason.Save)).toEqual({
      ok: false,
      error: TEAMS_NOTHING_CONFIGURED_ERROR,
    });
    expect(await validate(partial, ValidateConnectionReason.Save)).toEqual({
      ok: false,
      error: TEAMS_BOT_INCOMPLETE_ERROR,
    });
  });
});
