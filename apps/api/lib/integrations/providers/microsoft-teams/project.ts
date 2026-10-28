import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import type { IntegrationProjectDefinition } from "../../types";
import type { TeamsConnectionConfig } from "./connection";
import { normalizeChannelReference, parseChannelReference } from "./thread-ref";

/**
 * Project connections of Teams: the channels whose bot mentions start this
 * project's workflows. A channel belongs to one project connection of the
 * organization (per bot tenant). No channels: the project connection only
 * posts (microsoft_teams.post_message) and claims nothing.
 */

const CHANNELS_MAX = 50;

/** A channel id or a Teams link to the channel, stored as the lower-cased channel id. */
export const teamsChannelSchema = z.string().transform((value, context) => {
  const parsed = parseChannelReference(value);
  if (!parsed.ok) {
    context.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.value;
});

export const teamsProjectSettingsSchema = z.object({
  channels: z
    .array(teamsChannelSchema)
    .max(CHANNELS_MAX)
    .default([])
    .transform((channels) => [...new Set(channels)]),
});
export type TeamsProjectSettings = z.infer<typeof teamsProjectSettingsSchema>;

export const TEAMS_CHANNELS_FIELD_KEY = "channels";

const TEAMS_PROJECT_SETTINGS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: TEAMS_CHANNELS_FIELD_KEY,
    label: "Channels",
    kind: IntegrationFieldKind.StringList,
    placeholder:
      "https://teams.microsoft.com/l/channel/19%3a…%40thread.tacv2/…",
    description:
      'Channels where mentioning the bot starts this project\'s workflows: paste the link (••• next to the channel > "Get link to channel") or the channel id. A channel can belong to one project connection of the organization. Leave empty when the project only posts to Teams.',
  },
];

export const teamsProjectDefinition: IntegrationProjectDefinition<
  TeamsConnectionConfig,
  TeamsProjectSettings
> = {
  settingsSchema: teamsProjectSettingsSchema,
  settingsFields: TEAMS_PROJECT_SETTINGS_FIELDS,
  containers: (settings) => settings.channels,
  normalizeContainer: normalizeChannelReference,
  // Channel ids are unique within a tenant; mentions only arrive from the bot's.
  origin: (config) => config.tenantId ?? "",
  triggerContainersField: TEAMS_CHANNELS_FIELD_KEY,
};
