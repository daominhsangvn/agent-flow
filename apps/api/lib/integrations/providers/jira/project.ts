import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import type { IntegrationProjectDefinition } from "../../types";
import type { JiraConnectionConfig } from "./schemas";

/**
 * Project connections of Jira: a project works on some Jira projects of the
 * site (`projectKeys`). Several AgentFlow projects share the bot of one
 * connection and differ by their keys; a key belongs to one AgentFlow
 * project, whose project connections (one per bot connection) may share it.
 */

const PROJECT_KEYS_MAX = 50;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,254}$/;

export const jiraProjectSettingsSchema = z.object({
  projectKeys: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(PROJECT_KEY_RE, "Jira project keys look like PROJ or ABC_2")
    )
    .min(1, "Enter at least one Jira project key")
    .max(PROJECT_KEYS_MAX)
    .transform((keys) => [...new Set(keys)]),
});
export type JiraProjectSettings = z.infer<typeof jiraProjectSettingsSchema>;

const JIRA_PROJECT_SETTINGS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "projectKeys",
    label: "Jira projects",
    kind: IntegrationFieldKind.StringList,
    required: true,
    placeholder: "PROJ",
    description:
      "Keys of the Jira projects this project works on. Issues of these projects start this project's workflows; agents can only read and write issues of these projects. A key belongs to one project; its connections (one per bot) may share it.",
  },
];

export const jiraProjectDefinition: IntegrationProjectDefinition<
  JiraConnectionConfig,
  JiraProjectSettings
> = {
  settingsSchema: jiraProjectSettingsSchema,
  settingsFields: JIRA_PROJECT_SETTINGS_FIELDS,
  containers: (settings) => settings.projectKeys,
  normalizeContainer: (container) => container.trim().toUpperCase(),
  origin: (config) => config.siteUrl.toLowerCase(),
  triggerContainersField: "projectKeys",
};
