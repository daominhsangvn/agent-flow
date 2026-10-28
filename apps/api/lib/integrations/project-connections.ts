import type { JsonObject } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import {
  type ProjectConnection as ProjectConnectionRecord,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { parseWithSchema } from "./connection/provider-checks";
import { toJsonObject } from "./connection/stored-json";
import {
  type LoadedConnection,
  loadConnectionRuntime,
} from "./connection-service";
import { type AnyProvider, getIntegrationProvider } from "./registry";

/**
 * Project connections at run time: the organization connection's runtime
 * (its account: one Jira bot per connection) with the project settings, and
 * the source scopes a project connection claims
 * ("<provider>:<origin>:<container>", shared only by project connections of
 * one project, each of another connection).
 */

export type LoadedProjectConnection = {
  record: ProjectConnectionRecord;
  /** The organization connection, its runtime with the project settings. */
  connection: LoadedConnection;
  /** Parsed with the provider's project settings schema; {} without one. */
  settings: JsonObject;
};

/**
 * The project connection with its connection's runtime. Null (and a
 * warning) when it does not exist in the organization, its connection cannot
 * be loaded or its settings no longer parse.
 */
export async function loadProjectConnectionRuntime(
  organizationId: string,
  projectConnectionId: string
): Promise<LoadedProjectConnection | null> {
  if (!PROJECT_CONNECTION_ID_SCHEMA.safeParse(projectConnectionId).success) {
    return null;
  }
  const record = await withDb((db) =>
    db.projectConnection.findFirst({
      where: { id: projectConnectionId, organizationId },
    })
  );
  if (!record) {
    return null;
  }
  const loaded = await loadConnectionRuntime(
    organizationId,
    record.connectionId
  );
  if (!loaded) {
    return null;
  }
  const settings = parseProjectSettings(
    loaded.provider,
    toJsonObject(record.settings)
  );
  if (!settings.ok) {
    warnUnloadable(record, settings.error);
    return null;
  }
  return {
    record,
    connection: {
      ...loaded,
      runtime: { ...loaded.runtime, projectSettings: settings.value },
    },
    settings: settings.value,
  };
}

/** Project settings parsed with the provider's schema; {} without one. */
export function parseProjectSettings(
  provider: AnyProvider,
  settings: Record<string, unknown>
): Result<JsonObject, string> {
  if (!provider.project) {
    return Result.ok({});
  }
  return parseWithSchema(
    provider.project.settingsSchema,
    settings,
    "Invalid project settings"
  );
}

/** The scopes a project connection claims with these settings. */
export function projectScopeKeys(
  provider: AnyProvider,
  config: JsonObject,
  settings: JsonObject
): string[] {
  const project = provider.project;
  if (!project) {
    return [];
  }
  const origin = project.origin(config);
  return project
    .containers(settings)
    .map((container) => buildScopeKey(provider.key, origin, container));
}

/** The scope an item of the connection belongs to; null without a container. */
export function itemScopeKey(
  provider: AnyProvider,
  config: JsonObject,
  container: string | null
): string | null {
  const project = provider.project;
  if (!(project && container)) {
    return null;
  }
  return buildScopeKey(
    provider.key,
    project.origin(config),
    project.normalizeContainer(container)
  );
}

/**
 * The values of a trigger's container filter (Jira projectKeys, Azure DevOps
 * projects) that are not containers of the project connection; an empty
 * filter means all of the project connection's containers.
 */
export function triggerContainersOutside(
  providerKey: string,
  settings: JsonObject,
  triggerConfig: JsonObject
): string[] {
  const project = getIntegrationProvider(providerKey)?.project;
  if (!project) {
    return [];
  }
  const filter = triggerConfig[project.triggerContainersField];
  if (!Array.isArray(filter)) {
    return [];
  }
  const allowed = new Set(project.containers(settings));
  return filter.filter(
    (value): value is string =>
      typeof value === "string" &&
      !allowed.has(project.normalizeContainer(value))
  );
}

/** The container part of a scope key, for messages ("ABC"). */
export function scopeContainer(scopeKey: string): string {
  return scopeKey.slice(scopeKey.lastIndexOf(":") + 1);
}

const PROJECT_CONNECTION_ID_SCHEMA = z.uuid();

function buildScopeKey(
  providerKey: string,
  origin: string,
  container: string
): string {
  return `${providerKey}:${origin}:${container}`;
}

function warnUnloadable(record: ProjectConnectionRecord, reason: string) {
  log.warn("[integrations/project-connections] Runtime unavailable", {
    organizationId: record.organizationId,
    projectConnectionId: record.id,
    connectionId: record.connectionId,
    reason,
  });
}
