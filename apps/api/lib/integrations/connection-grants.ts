import type { JsonObject } from "@repo/api/src/types/common";
import {
  type ConnectionGrants,
  type NormalizedConnectionGrant,
  normalizeConnectionGrants,
  PULL_REQUESTS_CONNECTION_KEY,
  PullRequestOperation,
  SOURCE_CONNECTION_KEY,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { toJsonObject } from "./connection/stored-json";
import { findActionDefinition, getIntegrationProvider } from "./registry";
import type { IntegrationActionDefinition } from "./types";

/**
 * Project connections as workflows and processes name them (by key, per
 * project), and the checks of a `connections:` grant map against them. A key
 * used by a workflow must exist in every project its triggers use, with the
 * same provider; a grant may only list operations an agent can carry out on
 * that connection (source item writes are granted on `source`, pull requests
 * stay typed actions).
 */

export type ProjectConnectionEntry = {
  id: string;
  projectId: string;
  key: string;
  name: string;
  connectionId: string;
  provider: string;
  settings: JsonObject;
};

export type ProjectConnectionCatalog = {
  find(projectId: string, key: string): ProjectConnectionEntry | null;
  /** Every project connection of the project, in creation order. */
  list(projectId: string): ProjectConnectionEntry[];
  projectName(projectId: string): string;
};

/** The project connections of the given projects of the organization. */
export async function loadProjectConnectionCatalog(
  organizationId: string,
  projectIds: readonly string[]
): Promise<ProjectConnectionCatalog> {
  const ids = [...new Set(projectIds)];
  const [rows, projects] = await Promise.all([
    withDb((db) =>
      db.projectConnection.findMany({
        where: { organizationId, projectId: { in: ids } },
        include: { connection: { select: { provider: true } } },
        orderBy: { createdAt: "asc" },
      })
    ),
    withDb((db) =>
      db.project.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, name: true },
      })
    ),
  ]);
  const entries = rows.map(
    (row): ProjectConnectionEntry => ({
      id: row.id,
      projectId: row.projectId,
      key: row.key,
      name: row.name,
      connectionId: row.connectionId,
      provider: row.connection.provider,
      settings: toJsonObject(row.settings),
    })
  );
  return createProjectConnectionCatalog(entries, projects);
}

export function createProjectConnectionCatalog(
  entries: readonly ProjectConnectionEntry[],
  projects: ReadonlyArray<{ id: string; name: string }>
): ProjectConnectionCatalog {
  const byKey = new Map(
    entries.map((entry) => [`${entry.projectId}:${entry.key}`, entry])
  );
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return {
    find: (projectId, key) => byKey.get(`${projectId}:${key}`) ?? null,
    list: (projectId) =>
      entries.filter((entry) => entry.projectId === projectId),
    projectName: (projectId) => names.get(projectId) ?? "(unknown project)",
  };
}

/**
 * The project connections a key names in each project, which must all exist
 * and share a provider (the workflow's YAML is the same for every project).
 */
export function resolveKey(
  catalog: ProjectConnectionCatalog,
  projectIds: readonly string[],
  key: string
): Result<{ provider: string; entries: ProjectConnectionEntry[] }, string> {
  const entries: ProjectConnectionEntry[] = [];
  for (const projectId of projectIds) {
    const entry = catalog.find(projectId, key);
    if (!entry) {
      return Result.err(
        `project ${catalog.projectName(projectId)} has no connection "${key}". Add it on the project's Integrations tab.`
      );
    }
    entries.push(entry);
  }
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  if (providers.length > 1) {
    return Result.err(
      `connection "${key}" is ${providers.map(providerName).join(" in one project and ")} in another. Use one key per kind of connection.`
    );
  }
  return Result.ok({ provider: providers[0] ?? "", entries });
}

export type GrantCheckInput = {
  /** "Action 2", "Step investigate": prefixes every message. */
  label: string;
  grants: ConnectionGrants | undefined;
  catalog: ProjectConnectionCatalog;
  /** The projects the grants are resolved in (every trigger's project). */
  projectIds: readonly string[];
  /** Providers the run's source connection can have (the triggers'). */
  sourceProviders: readonly string[];
};

/** The first problem of a `connections:` map as a user-facing message, else null. */
export function checkConnectionGrants(input: GrantCheckInput): string | null {
  for (const grant of normalizeConnectionGrants(input.grants)) {
    const problem = checkGrant(grant, input);
    if (problem) {
      return `${input.label}: ${problem}`;
    }
  }
  return null;
}

/**
 * Provider action definitions a `source` grant allows on a source of this
 * provider (its comment and/or transition operations).
 */
export function sourceGrantDefinitions(
  provider: string,
  allow: readonly string[]
): IntegrationActionDefinition<unknown>[] {
  return (getIntegrationProvider(provider)?.actions ?? []).filter(
    (action) =>
      action.sourceOperation !== undefined &&
      allow.includes(action.sourceOperation)
  );
}

const SOURCE_OPERATIONS: readonly string[] = Object.values(SourceOperation);

function checkSourceGrant(
  grant: NormalizedConnectionGrant,
  sourceProviders: readonly string[]
): string | null {
  const unknown = grant.allow.find((op) => !SOURCE_OPERATIONS.includes(op));
  if (unknown) {
    return `connections.source allows ${SOURCE_OPERATIONS.join(", ")}, not "${unknown}".`;
  }
  for (const op of grant.allow) {
    const offered = sourceProviders.some(
      (provider) => sourceGrantDefinitions(provider, [op]).length > 0
    );
    if (!offered) {
      return `connections.source: no trigger's connection can ${op} its items.`;
    }
  }
  const definitions = sourceProviders.flatMap((provider) =>
    sourceGrantDefinitions(provider, grant.allow)
  );
  return checkFixedOptions(grant, definitions, "connections.source");
}

function checkConnectionGrant(
  grant: NormalizedConnectionGrant,
  input: GrantCheckInput
): string | null {
  const resolved = resolveKey(input.catalog, input.projectIds, grant.key);
  if (!resolved.ok) {
    return `connections.${grant.key}: ${resolved.error}`;
  }
  const { provider } = resolved.value;
  const definitions: IntegrationActionDefinition<unknown>[] = [];
  for (const op of grant.allow) {
    const definition = findActionDefinition(provider, op);
    if (!definition) {
      return `connections.${grant.key}: "${op}" is not an operation of ${providerName(provider)}.`;
    }
    if (definition.sourceOperation) {
      return `connections.${grant.key}: "${op}" works on the run's source item; grant it as source: [${definition.sourceOperation}].`;
    }
    if (definition.repositoryScoped) {
      return `connections.${grant.key}: "${op}" is opened by a typed action, not by an agent.`;
    }
    definitions.push(definition);
  }
  return checkFixedOptions(grant, definitions, `connections.${grant.key}`);
}

/** `with` may only fix options of the operations the grant allows. */
function checkFixedOptions(
  grant: NormalizedConnectionGrant,
  definitions: readonly IntegrationActionDefinition<unknown>[],
  path: string
): string | null {
  const known = new Set(
    definitions.flatMap((definition) =>
      definition.configFields.map((field) => field.key)
    )
  );
  const unknown = Object.keys(grant.with).find((key) => !known.has(key));
  return unknown
    ? `${path}.with: "${unknown}" is not an option of the allowed operations.`
    : null;
}

function providerName(provider: string): string {
  return getIntegrationProvider(provider)?.displayName ?? provider;
}

const PULL_REQUEST_OPERATIONS: readonly string[] =
  Object.values(PullRequestOperation);

/** `pull_requests`: read, or reply and resolve; nothing to fix with `with`. */
function checkPullRequestsGrant(
  grant: NormalizedConnectionGrant
): string | null {
  const unknown = grant.allow.find(
    (op) => !PULL_REQUEST_OPERATIONS.includes(op)
  );
  if (unknown) {
    return `connections.pull_requests allows read, ${PULL_REQUEST_OPERATIONS.join(", ")}, not "${unknown}".`;
  }
  return Object.keys(grant.with).length > 0
    ? "connections.pull_requests has no options to fix with `with`."
    : null;
}

function checkGrant(
  grant: NormalizedConnectionGrant,
  input: GrantCheckInput
): string | null {
  if (grant.key === SOURCE_CONNECTION_KEY) {
    return checkSourceGrant(grant, input.sourceProviders);
  }
  if (grant.key === PULL_REQUESTS_CONNECTION_KEY) {
    return checkPullRequestsGrant(grant);
  }
  return checkConnectionGrant(grant, input);
}
