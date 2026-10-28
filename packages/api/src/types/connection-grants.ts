import { z } from "zod";
import type { JsonValue } from "./common.ts";
import {
  PROJECT_CONNECTION_KEY_RE,
  PROJECT_CONNECTION_RESERVED_KEYS,
} from "./project-connection.ts";

/**
 * What an agent may do through project connections: the `connections:` map of
 * an instruction action or a process agent step. Agents are read-only by
 * default — they can read the run's source item and nothing else. Every write
 * is listed here, by the admin who writes the workflow or the process:
 *
 * ```yaml
 * connections:
 *   source: [comment, transition, label, link]  # write on the run's source item
 *   jira-internal:                          # a project connection, by key
 *     allow: [jira.create_issue]
 *     with: { projectKey: OPS }             # fixed; the agent cannot change it
 *     approval: required                    # a person approves each write
 *   jira-archive: read                      # read other items
 * ```
 *
 * `source` is the run's source connection (the one whose item started the
 * run); its writes are named generically (`comment`, `transition`, `label`,
 * `link`) because the source may be Jira or Azure DevOps. Other keys list
 * provider operation types. Any write implies read.
 */

/** The run's source connection in a `connections:` map. */
export const SOURCE_CONNECTION_KEY = "source";

/**
 * The run's pull requests in a `connections:` map (docs/workflows.md "Pull
 * request review tools"): `read` their review threads, or `[reply, resolve]`
 * them. The connection of each pull request is its repository's, whatever
 * the provider.
 */
export const PULL_REQUESTS_CONNECTION_KEY = "pull_requests";

/** Writes on the review threads of the run's pull requests. */
export const PullRequestOperation = {
  Reply: "reply",
  Resolve: "resolve",
} as const;
export type PullRequestOperation =
  (typeof PullRequestOperation)[keyof typeof PullRequestOperation];

/** Writes on the run's source item, whatever its provider. */
export const SourceOperation = {
  Comment: "comment",
  Transition: "transition",
  /** Add or remove labels (Jira) or tags (Azure DevOps). */
  Label: "label",
  /** Add a web link, e.g. the page the plan is reviewed on. */
  Link: "link",
} as const;
export type SourceOperation =
  (typeof SourceOperation)[keyof typeof SourceOperation];

export const ConnectionAccess = {
  Read: "read",
} as const;
export type ConnectionAccess =
  (typeof ConnectionAccess)[keyof typeof ConnectionAccess];

export const GrantApproval = {
  Required: "required",
} as const;
export type GrantApproval = (typeof GrantApproval)[keyof typeof GrantApproval];

export const CONNECTION_GRANTS_MAX = 10;
export const CONNECTION_GRANT_OPERATIONS_MAX = 20;
const OPERATION_TYPE_MAX = 64;

/** A fixed option's value: plain JSON. Typed explicitly so declarations stay portable. */
const fixedValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(fixedValueSchema),
    z.record(z.string(), fixedValueSchema),
  ])
);

const operationListSchema = z
  .array(z.string().trim().min(1).max(OPERATION_TYPE_MAX))
  .min(1, "List at least one operation")
  .max(CONNECTION_GRANT_OPERATIONS_MAX);

const grantObjectSchema = z
  .object({
    allow: operationListSchema,
    /** Fixed operation options; the agent's value for these is ignored. */
    with: z.record(z.string(), fixedValueSchema).optional(),
    approval: z.enum(GrantApproval).optional(),
  })
  .strict();

export const connectionGrantSchema = z.union([
  z.literal(ConnectionAccess.Read),
  operationListSchema,
  grantObjectSchema,
]);
export type ConnectionGrant = z.infer<typeof connectionGrantSchema>;

export const connectionGrantKeySchema = z
  .string()
  .refine(
    (key) =>
      key === SOURCE_CONNECTION_KEY ||
      key === PULL_REQUESTS_CONNECTION_KEY ||
      (PROJECT_CONNECTION_KEY_RE.test(key) &&
        !PROJECT_CONNECTION_RESERVED_KEYS.includes(key)),
    { message: "Use source, pull_requests or a project connection key" }
  );

export const connectionGrantsSchema = z
  .record(connectionGrantKeySchema, connectionGrantSchema)
  .refine((grants) => Object.keys(grants).length <= CONNECTION_GRANTS_MAX, {
    message: `At most ${CONNECTION_GRANTS_MAX} connections`,
  });
export type ConnectionGrants = z.infer<typeof connectionGrantsSchema>;

/** A grant in one shape: what it allows, its fixed options, its approval. */
export type NormalizedConnectionGrant = {
  key: string;
  /** Operation types (provider types, or SourceOperation values on `source`). */
  allow: string[];
  with: Record<string, JsonValue>;
  approvalRequired: boolean;
};

export function normalizeConnectionGrant(
  key: string,
  grant: ConnectionGrant
): NormalizedConnectionGrant {
  if (grant === ConnectionAccess.Read) {
    return { key, allow: [], with: {}, approvalRequired: false };
  }
  if (Array.isArray(grant)) {
    return { key, allow: [...grant], with: {}, approvalRequired: false };
  }
  return {
    key,
    allow: [...grant.allow],
    with: { ...(grant.with ?? {}) },
    approvalRequired: grant.approval === GrantApproval.Required,
  };
}

/** Every grant of a `connections:` map, normalized, in map order. */
export function normalizeConnectionGrants(
  grants: ConnectionGrants | undefined
): NormalizedConnectionGrant[] {
  return Object.entries(grants ?? {}).map(([key, grant]) =>
    normalizeConnectionGrant(key, grant)
  );
}
