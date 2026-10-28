/**
 * Named values of the Microsoft Teams provider: trigger/action keys, event
 * attribute and extras keys, and the reasons a bot delivery produces no event.
 */

export const TeamsTriggerType = {
  BotMentioned: "microsoft_teams.bot_mentioned",
} as const;
export type TeamsTriggerType =
  (typeof TeamsTriggerType)[keyof typeof TeamsTriggerType];

/**
 * Events no trigger matches: a reply in a thread that does not mention the
 * bot. Only a project orchestrator that already talks in the thread takes it
 * (docs/orchestrator.md).
 */
export const TeamsSignalType = {
  ThreadReply: "microsoft_teams.thread_reply",
} as const;
export type TeamsSignalType =
  (typeof TeamsSignalType)[keyof typeof TeamsSignalType];

/** Keys of InboundEvent.attributes produced by this provider. */
export const TeamsEventAttribute = {
  /** Channel id, lower-cased like project settings store it. */
  ChannelId: "channelId",
  /** Microsoft 365 group id of the team. */
  TeamId: "teamId",
  /** The mention is a reply in an existing thread (not a new post). */
  Reply: "reply",
} as const;
export type TeamsEventAttribute =
  (typeof TeamsEventAttribute)[keyof typeof TeamsEventAttribute];

/**
 * Keys of InboundEvent.extras (run.sourceExtras): what microsoft_teams.reply
 * needs to answer in the thread, taken from the verified activity.
 */
export const TeamsExtra = {
  ServiceUrl: "teamsServiceUrl",
  /** The thread's conversation id ("19:…@thread.tacv2;messageid=…"). */
  ConversationId: "teamsConversationId",
  RequesterId: "teamsRequesterId",
  RequesterName: "teamsRequesterName",
} as const;
export type TeamsExtra = (typeof TeamsExtra)[keyof typeof TeamsExtra];

/** Why a verified bot delivery produced no event. Logged on the delivery. */
export const TeamsIgnoredReason = {
  InvalidPayload: "invalid_payload",
  UnsupportedActivity: "unsupported_activity",
  /** Group chats and personal chats: only channels and their threads are supported. */
  NotAChannel: "not_a_channel",
  OtherTenant: "other_tenant",
  NotMentioned: "bot_not_mentioned",
  CausedByBot: "caused_by_bot",
  BotNotConfigured: "bot_not_configured",
} as const;
export type TeamsIgnoredReason =
  (typeof TeamsIgnoredReason)[keyof typeof TeamsIgnoredReason];

/** Bot Framework activity values the provider reads. */
export const TeamsActivityType = {
  Message: "message",
} as const;

export const TEAMS_CHANNEL_ID = "msteams";
export const TEAMS_CHANNEL_CONVERSATION_TYPE = "channel";
/** Bot accounts in Teams are "28:" + the bot's Microsoft App ID. */
export const TEAMS_BOT_ID_PREFIX = "28:";

export function teamsBotId(appId: string): string {
  return `${TEAMS_BOT_ID_PREFIX}${appId}`;
}
