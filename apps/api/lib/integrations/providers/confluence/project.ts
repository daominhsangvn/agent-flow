import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import type { IntegrationProjectDefinition } from "../../types";
import type { ConfluenceConnectionConfig } from "./schemas";

/**
 * Project connections of Confluence: the spaces the project's agents and
 * actions may read and write (`spaceKeys`), and where new pages go
 * (`parentPageId`). Unlike Jira projects, spaces are not claimed: several
 * projects may share a space, and nothing starts a run from Confluence.
 */

const SPACE_KEYS_MAX = 20;
/** Global spaces (ENG, TEAM_2) and personal ones (~5b10ac8d82e05b22cc7d4ef5). */
const SPACE_KEY_RE = /^(?:[A-Za-z0-9_]{1,255}|~[A-Za-z0-9_:-]{1,255})$/;
const PAGE_ID_RE = /^\d{1,20}$/;

export const confluenceProjectSettingsSchema = z.object({
  spaceKeys: z
    .array(
      z
        .string()
        .trim()
        .regex(SPACE_KEY_RE, "Confluence space keys look like ENG or TEAM_2")
    )
    .min(1, "Enter at least one Confluence space key")
    .max(SPACE_KEYS_MAX)
    .transform((keys) => [...new Set(keys)]),
  parentPageId: z
    .string()
    .trim()
    .regex(PAGE_ID_RE, "Enter the page id, e.g. 123456")
    .nullish()
    .or(z.literal("").transform(() => null)),
});
export type ConfluenceProjectSettings = z.infer<
  typeof confluenceProjectSettingsSchema
>;

const CONFLUENCE_PROJECT_SETTINGS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "spaceKeys",
    label: "Spaces",
    kind: IntegrationFieldKind.StringList,
    required: true,
    placeholder: "ENG",
    description:
      "Keys of the Confluence spaces this project works in. Agents and actions can only read and write pages and comments of these spaces.",
  },
  {
    key: "parentPageId",
    label: "Parent page id",
    kind: IntegrationFieldKind.Text,
    placeholder: "123456",
    description:
      "Where new pages go when an agent or action does not name a parent (the number in the page's URL). Leave empty for the top of the space.",
  },
];

export const confluenceProjectDefinition: IntegrationProjectDefinition<
  ConfluenceConnectionConfig,
  ConfluenceProjectSettings
> = {
  settingsSchema: confluenceProjectSettingsSchema,
  settingsFields: CONFLUENCE_PROJECT_SETTINGS_FIELDS,
  // Spaces are not claimed: nothing starts runs from Confluence.
  containers: () => [],
  normalizeContainer: (container) => container.trim(),
  origin: (config) => config.siteUrl.toLowerCase(),
  triggerContainersField: "spaceKeys",
};
