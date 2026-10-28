import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { z } from "zod";
import { defineTrigger, type InboundEvent } from "../../types";
import type { TeamsConnectionConfig } from "./connection";
import { TeamsEventAttribute, TeamsTriggerType } from "./constants";
import { TEAMS_CHANNELS_FIELD_KEY, teamsChannelSchema } from "./project";

/**
 * microsoft_teams.bot_mentioned: someone mentions the bot in a channel post
 * or a reply. Anyone in the channel may ask; the request is their message,
 * the thread is its context. Mentioning the bot again in a thread whose run
 * waits for input resumes that run; while it is busy, the mention is
 * recorded and ignored.
 */

const CHANNEL_FILTER_MAX = 50;

export const teamsBotMentionedConfigSchema = z.object({
  /** Empty: every channel of the project connection. */
  [TEAMS_CHANNELS_FIELD_KEY]: z
    .array(teamsChannelSchema)
    .max(CHANNEL_FILTER_MAX)
    .default([])
    .transform((channels) => [...new Set(channels)]),
});
export type TeamsBotMentionedConfig = z.infer<
  typeof teamsBotMentionedConfigSchema
>;

export const teamsBotMentionedTrigger = defineTrigger<
  TeamsBotMentionedConfig,
  TeamsConnectionConfig
>({
  key: TeamsTriggerType.BotMentioned,
  displayName: "Bot mentioned in a channel",
  description:
    "Starts a run when someone mentions the bot with @ in a channel post or a thread reply. The run reads the whole thread and carries out the message that mentioned the bot. Needs the bot fields of the connection and webhook delivery (the inbound URL is the Azure Bot's messaging endpoint).",
  configSchema: teamsBotMentionedConfigSchema,
  configFields: [
    {
      key: TEAMS_CHANNELS_FIELD_KEY,
      label: "Channels",
      kind: IntegrationFieldKind.StringList,
      defaultValue: [],
      placeholder:
        "https://teams.microsoft.com/l/channel/19%3a…%40thread.tacv2/…",
      description:
        "Only mentions in these channels (links or channel ids). Leave empty for every channel of the project connection.",
    },
  ],
  matches: (event, config) => matchesChannel(event, config.channels),
});

function matchesChannel(
  event: InboundEvent,
  channels: readonly string[]
): boolean {
  if (channels.length === 0) {
    return true;
  }
  const channel = event.attributes[TeamsEventAttribute.ChannelId];
  return typeof channel === "string" && channels.includes(channel);
}
