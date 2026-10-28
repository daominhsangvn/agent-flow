import { createHash } from "node:crypto";
import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { z } from "zod";
import type {
  InboundEvent,
  InboundParseResult,
  InboundRequest,
} from "../../types";
import { checkServiceUrl, getTeamGroupId } from "./bot-connector";
import { readBotCredentials, type TeamsProviderContext } from "./connection";
import {
  TEAMS_CHANNEL_CONVERSATION_TYPE,
  TEAMS_CHANNEL_ID,
  TeamsActivityType,
  TeamsEventAttribute,
  TeamsExtra,
  TeamsIgnoredReason,
  TeamsSignalType,
  TeamsTriggerType,
  teamsBotId,
} from "./constants";
import { acquireEntraToken, BOT_FRAMEWORK_SCOPE } from "./entra-token";
import { activityText, firstLine } from "./message-text";
import {
  encodeThreadExternalId,
  isTeamsMessageId,
  rootMessageIdOf,
  type TeamsThreadRef,
  teamsMessageLink,
  teamsThreadKey,
  threadConversationId,
} from "./thread-ref";

/**
 * Inbound side of the Teams bot (webhook mode: the inbound URL is the Azure
 * Bot's messaging endpoint). verifyTeamsRequest (bot-auth.ts) has already
 * checked the Bot Framework token.
 *
 * Only `message` activities in a channel of the bot's tenant produce an
 * event: one that mentions the bot is microsoft_teams.bot_mentioned (a new
 * post or a reply in a thread); a reply in a thread that does not is
 * microsoft_teams.thread_reply, which no trigger matches and only a project
 * orchestrator already talking in the thread takes. With the
 * ChannelMessage.Read.Group permission Teams sends the bot every channel
 * message: new posts without a mention are acknowledged with an ignored
 * reason, as are installs, edits, reactions and messages of the bot itself.
 * Ingest only reads: answering is microsoft_teams.reply.
 */

const DELIVERY_ID_MAX_LENGTH = 255;
const EVENT_TYPE_MAX_LENGTH = 128;
const TITLE_MAX_LENGTH = 200;
const MENTION_ENTITY_TYPE = "mention";

const accountSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
  aadObjectId: z.string().nullish(),
});

const mentionEntitySchema = z.looseObject({
  type: z.literal(MENTION_ENTITY_TYPE),
  mentioned: accountSchema,
  text: z.string().nullish(),
});

const activitySchema = z.looseObject({
  type: z.string().min(1),
  id: z.string().nullish(),
  timestamp: z.string().nullish(),
  channelId: z.string(),
  serviceUrl: z.string().min(1),
  from: accountSchema.nullish(),
  conversation: z.looseObject({
    id: z.string().min(1),
    conversationType: z.string().nullish(),
    tenantId: z.string().nullish(),
  }),
  text: z.string().nullish(),
  entities: z.array(z.unknown()).nullish(),
  channelData: z
    .looseObject({
      tenant: z.looseObject({ id: z.string().nullish() }).nullish(),
      team: z
        .looseObject({
          id: z.string().nullish(),
          aadGroupId: z.string().nullish(),
        })
        .nullish(),
      channel: z.looseObject({ id: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type TeamsActivity = z.infer<typeof activitySchema>;

export async function parseTeamsRequest(
  request: InboundRequest,
  ctx: TeamsProviderContext
): Promise<InboundParseResult> {
  const activity = parseActivity(request.rawBody);
  if (!activity) {
    return ignored(
      bodyDeliveryId(request.rawBody),
      null,
      TeamsIgnoredReason.InvalidPayload
    );
  }
  const deliveryId = activityDeliveryId(activity, request.rawBody);
  const eventType = activity.type.slice(0, EVENT_TYPE_MAX_LENGTH);
  const decided = decideActivity(activity, ctx);
  if (!decided.ok) {
    return ignored(deliveryId, eventType, decided.reason);
  }
  const event = await buildMentionEvent(activity, decided.value, ctx);
  return { deliveryId, eventType, events: [event] };
}

type MentionFacts = {
  appId: string;
  tenantId: string;
  channelId: string;
  rootMessageId: string;
  messageId: string;
  /** False for a reply in a thread that does not mention the bot. */
  mentioned: boolean;
  botMentionTexts: string[];
};

type Decision =
  | { ok: true; value: MentionFacts }
  | { ok: false; reason: TeamsIgnoredReason };

/** Whether the activity is a mention of the bot in a channel of its tenant. */
function decideActivity(
  activity: TeamsActivity,
  ctx: TeamsProviderContext
): Decision {
  const { appId, tenantId } = ctx.connection.config;
  if (!(appId && tenantId)) {
    return { ok: false, reason: TeamsIgnoredReason.BotNotConfigured };
  }
  if (
    activity.type !== TeamsActivityType.Message ||
    activity.channelId !== TEAMS_CHANNEL_ID
  ) {
    return { ok: false, reason: TeamsIgnoredReason.UnsupportedActivity };
  }
  const botId = teamsBotId(appId).toLowerCase();
  if (activity.from?.id.toLowerCase() === botId) {
    return { ok: false, reason: TeamsIgnoredReason.CausedByBot };
  }
  const channelId = activity.channelData?.channel?.id ?? null;
  const messageId = activity.id ?? null;
  if (
    activity.conversation.conversationType !==
      TEAMS_CHANNEL_CONVERSATION_TYPE ||
    !channelId ||
    !(messageId && isTeamsMessageId(messageId))
  ) {
    return { ok: false, reason: TeamsIgnoredReason.NotAChannel };
  }
  const activityTenant =
    activity.channelData?.tenant?.id ?? activity.conversation.tenantId ?? "";
  if (activityTenant.toLowerCase() !== tenantId) {
    return { ok: false, reason: TeamsIgnoredReason.OtherTenant };
  }
  const botMentions = mentionEntities(activity).filter(
    (mention) => mention.mentioned.id.toLowerCase() === botId
  );
  // A new post is its own thread root.
  const rootMessageId = rootMessageIdOf(activity.conversation.id) ?? messageId;
  if (botMentions.length === 0 && rootMessageId === messageId) {
    return { ok: false, reason: TeamsIgnoredReason.NotMentioned };
  }
  return {
    ok: true,
    value: {
      appId,
      tenantId,
      channelId,
      rootMessageId,
      messageId,
      mentioned: botMentions.length > 0,
      botMentionTexts: botMentions.flatMap((mention) =>
        mention.text ? [mention.text] : []
      ),
    },
  };
}

async function buildMentionEvent(
  activity: TeamsActivity,
  facts: MentionFacts,
  ctx: TeamsProviderContext
): Promise<InboundEvent> {
  const teamId = await resolveTeamGroupId(activity, ctx);
  const ref: TeamsThreadRef = {
    teamId,
    channelId: facts.channelId,
    rootMessageId: facts.rootMessageId,
    messageId: facts.messageId,
  };
  const text = activityText(activity.text, facts.botMentionTexts);
  const title = firstLine(text).slice(0, TITLE_MAX_LENGTH) || "Teams request";
  const requester = activity.from ?? null;
  return {
    triggerType: facts.mentioned
      ? TeamsTriggerType.BotMentioned
      : TeamsSignalType.ThreadReply,
    dedupKey: `${threadConversationId(facts.channelId, facts.rootMessageId)}:${facts.mentioned ? "mention" : "reply"}:${facts.messageId}`,
    occurredAt: parseTimestamp(activity.timestamp) ?? ctx.now(),
    actor: requester
      ? {
          id: requester.aadObjectId ?? requester.id,
          displayName: requester.name ?? null,
        }
      : null,
    item: {
      provider: IntegrationProviderKey.MicrosoftTeams,
      externalId: encodeThreadExternalId(ref),
      key: teamsThreadKey(facts.channelId, facts.rootMessageId),
      url: teamsMessageLink(ref, facts.tenantId),
      title,
      container: facts.channelId,
    },
    attributes: {
      [TeamsEventAttribute.ChannelId]: facts.channelId.toLowerCase(),
      [TeamsEventAttribute.TeamId]: teamId || null,
      [TeamsEventAttribute.Reply]: facts.messageId !== facts.rootMessageId,
    },
    extras: replyExtras(activity, facts),
    message: {
      id: facts.messageId,
      parentId:
        facts.messageId === facts.rootMessageId ? null : facts.rootMessageId,
      text,
    },
  };
}

/**
 * What microsoft_teams.reply needs: the verified activity's service URL and
 * the thread's conversation, and who asked (to mention them in answers).
 */
function replyExtras(activity: TeamsActivity, facts: MentionFacts): JsonObject {
  const extras: JsonObject = {
    [TeamsExtra.ServiceUrl]: activity.serviceUrl,
    [TeamsExtra.ConversationId]: threadConversationId(
      facts.channelId,
      facts.rootMessageId
    ),
  };
  if (activity.from) {
    extras[TeamsExtra.RequesterId] = activity.from.id;
    extras[TeamsExtra.RequesterName] = activity.from.name ?? null;
  }
  return extras;
}

/**
 * Graph addresses teams by their Microsoft 365 group id. Channel activities
 * usually carry it; otherwise the Bot Connector's team details do. Empty when
 * neither is available: reading the thread then fails with an explanation.
 */
async function resolveTeamGroupId(
  activity: TeamsActivity,
  ctx: TeamsProviderContext
): Promise<string> {
  const team = activity.channelData?.team;
  if (team?.aadGroupId) {
    return team.aadGroupId;
  }
  const serviceUrl = checkServiceUrl(activity.serviceUrl);
  const bot = readBotCredentials(ctx.connection);
  if (!(team?.id && serviceUrl && bot.ok && bot.value)) {
    return "";
  }
  const token = await acquireEntraToken(
    ctx.http,
    bot.value,
    BOT_FRAMEWORK_SCOPE,
    ctx.now()
  );
  if (!token.ok) {
    ctx.log.warn("Could not sign the Teams bot in to read the team", {
      connectionId: ctx.connection.id,
      status: token.error.status,
    });
    return "";
  }
  const groupId = await getTeamGroupId(ctx.http, {
    serviceUrl,
    token: token.value,
    teamId: team.id,
  });
  if (!groupId) {
    ctx.log.warn("Could not read the Teams team's group id", {
      connectionId: ctx.connection.id,
    });
  }
  return groupId ?? "";
}

function mentionEntities(activity: TeamsActivity) {
  return (activity.entities ?? []).flatMap((entity) => {
    const mention = mentionEntitySchema.safeParse(entity);
    return mention.success ? [mention.data] : [];
  });
}

function parseActivity(rawBody: string): TeamsActivity | null {
  try {
    const parsed = activitySchema.safeParse(JSON.parse(rawBody));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** "{conversation id}:{activity id}" (stable across Bot Framework retries), else a hash of the body. */
function activityDeliveryId(activity: TeamsActivity, rawBody: string): string {
  const id = activity.id ? `${activity.conversation.id}:${activity.id}` : "";
  return id && id.length <= DELIVERY_ID_MAX_LENGTH
    ? id
    : bodyDeliveryId(rawBody);
}

function bodyDeliveryId(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function ignored(
  deliveryId: string,
  eventType: string | null,
  reason: TeamsIgnoredReason
): InboundParseResult {
  return { deliveryId, eventType, events: [], ignoredReason: reason };
}
