import { z } from "zod";
import type { JsonObject } from "./common.ts";

/**
 * Project connections: a project's use of an organization integration
 * connection (Project settings → Integrations, org admins only).
 *
 * - `key` is the stable reference workflows, process steps and agent tools
 *   use (`connection: jira-billing`); it never changes after creation.
 * - `settings` narrows what the project works on, validated by the provider
 *   (Jira `projectKeys`, Azure DevOps `projects`). The items a project
 *   connection claims belong to one project.
 * - The account is the connection's: an organization connection is one
 *   account (one Jira bot), added to a project at most once. For one bot per
 *   workflow, an admin adds one connection per bot and the project uses
 *   several of them with the same project keys; each hears the items with
 *   its own bot.
 */

export const PROJECT_CONNECTION_KEY_MAX = 40;
export const PROJECT_CONNECTION_NAME_MAX = 120;

/** Lowercase letters, digits and dashes, starting with a letter: `jira-billing`. */
export const PROJECT_CONNECTION_KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Keys with a meaning of their own in workflow and process YAML: `source` is
 * the run's source connection (the one whose trigger started the run).
 */
export const PROJECT_CONNECTION_RESERVED_KEYS: readonly string[] = ["source"];

export const projectConnectionKeySchema = z
  .string()
  .trim()
  .regex(
    PROJECT_CONNECTION_KEY_RE,
    "Use 2-40 lowercase letters, digits and dashes, starting with a letter"
  )
  .refine((key) => !PROJECT_CONNECTION_RESERVED_KEYS.includes(key), {
    message: "This key is reserved",
  });

export type ProjectConnection = {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  provider: string;
  key: string;
  name: string;
  settings: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectConnectionsResponse = {
  connections: ProjectConnection[];
};

/** A project that uses an integration connection, for the org connection page. */
export type IntegrationConnectionProjectUsage = {
  projectConnectionId: string;
  projectId: string;
  projectName: string;
  key: string;
  name: string;
};

export type IntegrationConnectionProjectsResponse = {
  projects: IntegrationConnectionProjectUsage[];
};

/** How many connections one request adds to a project. */
export const PROJECT_CONNECTIONS_ADD_MAX = 10;

export const projectConnectionEntryInputSchema = z.object({
  connectionId: z.uuid(),
  key: projectConnectionKeySchema,
  name: z.string().trim().min(1).max(PROJECT_CONNECTION_NAME_MAX),
});
export type ProjectConnectionEntryInput = z.infer<
  typeof projectConnectionEntryInputSchema
>;

/**
 * POST /projects/{id}/connections: one or more organization connections of
 * one provider (one bot each), each under its own key, with the same project
 * settings. All are added or none.
 */
export const createProjectConnectionsInputSchema = z
  .object({
    connections: z
      .array(projectConnectionEntryInputSchema)
      .min(1, "Choose at least one connection")
      .max(PROJECT_CONNECTIONS_ADD_MAX),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((input, ctx) => {
    const keys = input.connections.map((entry) => entry.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["connections"],
        message: "Give each connection its own key",
      });
    }
    const ids = input.connections.map((entry) => entry.connectionId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["connections"],
        message: "Choose each connection once",
      });
    }
  });
export type CreateProjectConnectionsInput = z.infer<
  typeof createProjectConnectionsInputSchema
>;

/**
 * PATCH /projects/{id}/connections/{projectConnectionId}. Only the fields
 * sent change. The connection and the key cannot change.
 */
export const updateProjectConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(PROJECT_CONNECTION_NAME_MAX),
    settings: z.record(z.string(), z.unknown()),
  })
  .partial();
export type UpdateProjectConnectionInput = z.infer<
  typeof updateProjectConnectionInputSchema
>;

/** A key suggestion for a display name: "Jira – Billing" → "jira-billing". */
export function suggestProjectConnectionKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  const withLetter = LEADING_LETTER_RE.test(slug) ? slug : `c-${slug}`;
  const key = withLetter
    .slice(0, PROJECT_CONNECTION_KEY_MAX)
    .replace(TRAILING_DASHES_RE, "");
  return PROJECT_CONNECTION_KEY_RE.test(key) ? key : "connection";
}

const LEADING_LETTER_RE = /^[a-z]/;
const TRAILING_DASHES_RE = /-+$/;
