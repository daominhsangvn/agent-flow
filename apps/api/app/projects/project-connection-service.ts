import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateProjectConnectionsInput,
  IntegrationConnectionProjectUsage,
  ProjectConnection,
  ProjectConnectionEntryInput,
  UpdateProjectConnectionInput,
} from "@repo/api/src/types/project-connection";
import {
  ProcessStepType,
  type ProjectProcess,
} from "@repo/api/src/types/project-process";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { workflowAgentConfigSchema } from "@repo/api/src/types/workflow";
import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";
import {
  CurrentProcessKind,
  projectProcessService,
} from "@/app/projects/project-process-service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { toJsonObject } from "@/lib/integrations/connection/stored-json";
import {
  type LoadedConnection,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import {
  parseProjectSettings,
  projectScopeKeys,
  scopeContainer,
} from "@/lib/integrations/project-connections";

/**
 * Project connections (Project settings → Integrations, org admins only): a
 * project's use of an organization integration connection under a stable
 * key, with project settings. The account is the connection's: one Jira bot
 * per connection, so a project that wants one bot per workflow uses several
 * connections, added together with the same project settings.
 *
 * Conflicts are refused: a key used twice in a project, a connection added
 * twice to a project, and source items (Jira project keys, Azure DevOps
 * projects) claimed by project connections of two projects. Project
 * connections of one project may share source items (one connection, i.e.
 * one bot, each). Writes take an organization-wide advisory lock so these
 * checks hold under concurrent requests; the unique indexes back them up.
 */

export type ProjectConnectionServiceError = {
  status: StatusCode;
  message: string;
};

type ServiceResult<T> = Result<T, ProjectConnectionServiceError>;

export const projectConnectionService = {
  /** Null when the project does not exist in the organization. */
  async list(
    organizationId: string,
    projectId: string
  ): Promise<ProjectConnection[] | null> {
    if (!(await projectExists(organizationId, projectId))) {
      return null;
    }
    const records = await withDb((db) =>
      db.projectConnection.findMany({
        where: { organizationId, projectId },
        include: PROJECT_CONNECTION_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    );
    return records.map(toProjectConnectionDto);
  },

  /**
   * Adds one or more connections of one provider to the project, each under
   * its own key, with the same project settings. All are added or none.
   */
  async add(
    organizationId: string,
    projectId: string,
    userId: string,
    input: CreateProjectConnectionsInput
  ): Promise<ServiceResult<ProjectConnection[]>> {
    if (!(await projectExists(organizationId, projectId))) {
      return serviceError(Status.NotFound, "Project not found");
    }
    const prepared = await prepareEntries(organizationId, input);
    if (!prepared.ok) {
      return prepared;
    }
    const { settings, entries } = prepared.value;
    return await writeGuarded(() =>
      withDb.tx(async (tx) => {
        await lockOrganization(tx, organizationId);
        for (const entry of entries) {
          const conflict = await findConflict(tx, {
            organizationId,
            projectId,
            connectionId: entry.input.connectionId,
            key: entry.input.key,
            scopes: entry.scopes,
          });
          if (conflict) {
            return serviceError(Status.Conflict, conflict);
          }
        }
        const created: ProjectConnection[] = [];
        for (const entry of entries) {
          const record = await tx.projectConnection.create({
            data: {
              organizationId,
              projectId,
              connectionId: entry.input.connectionId,
              key: entry.input.key,
              name: entry.input.name,
              settings,
              createdById: userId,
            },
            include: PROJECT_CONNECTION_INCLUDE,
          });
          await replaceScopes(tx, record, entry.scopes);
          created.push(toProjectConnectionDto(record));
        }
        return Result.ok(created);
      })
    );
  },

  /**
   * Changes the name or the settings (and with them the claimed source
   * items). The connection and the key never change.
   */
  async update(
    organizationId: string,
    projectId: string,
    projectConnectionId: string,
    input: UpdateProjectConnectionInput
  ): Promise<ServiceResult<ProjectConnection>> {
    const record = await findRecord(
      organizationId,
      projectId,
      projectConnectionId
    );
    if (!record) {
      return notFound();
    }
    const loaded = await loadUsableConnection(
      organizationId,
      record.connectionId
    );
    if (!loaded.ok) {
      return loaded;
    }
    let settings: JsonObject | null = null;
    let scopes: string[] | null = null;
    if (input.settings !== undefined) {
      const parsed = parseSettings(loaded.value, input.settings);
      if (!parsed.ok) {
        return parsed;
      }
      ({ settings, scopes } = parsed.value);
    }
    return await writeGuarded(() =>
      withDb.tx(async (tx) => {
        await lockOrganization(tx, organizationId);
        const conflict = await findScopeConflict(tx, {
          organizationId,
          projectId,
          scopes: scopes ?? [],
        });
        if (conflict) {
          return serviceError(Status.Conflict, conflict);
        }
        const updated = await tx.projectConnection.update({
          where: { id: record.id },
          data: {
            name: input.name,
            ...(settings === null ? {} : { settings }),
          },
          include: PROJECT_CONNECTION_INCLUDE,
        });
        if (scopes !== null) {
          await replaceScopes(tx, updated, scopes);
        }
        return Result.ok(toProjectConnectionDto(updated));
      })
    );
  },

  async remove(
    organizationId: string,
    projectId: string,
    projectConnectionId: string
  ): Promise<ServiceResult<{ deleted: true }>> {
    const record = await findRecord(
      organizationId,
      projectId,
      projectConnectionId
    );
    if (!record) {
      return notFound();
    }
    const users = await findUsers(organizationId, projectId, record.key);
    if (users.length > 0) {
      return serviceError(
        Status.Conflict,
        `"${record.key}" is used by ${users.join(", ")}. Remove it there first.`
      );
    }
    await writeGuarded(async () => {
      await withDb((db) =>
        db.projectConnection.deleteMany({
          where: { id: record.id, organizationId, projectId },
        })
      );
      return Result.ok(null);
    });
    return Result.ok({ deleted: true });
  },

  /** Every project connection of the organization (the workflow editor's catalog). */
  async listAll(organizationId: string): Promise<ProjectConnection[]> {
    const records = await withDb((db) =>
      db.projectConnection.findMany({
        where: { organizationId },
        include: PROJECT_CONNECTION_INCLUDE,
        orderBy: { createdAt: "asc" },
        take: PROJECT_CONNECTIONS_LIST_MAX,
      })
    );
    return records.map(toProjectConnectionDto);
  },

  /** The projects using an organization connection; null when it does not exist. */
  async listForConnection(
    organizationId: string,
    connectionId: string
  ): Promise<IntegrationConnectionProjectUsage[] | null> {
    const connection = await withDb((db) =>
      db.integrationConnection.findFirst({
        where: { id: connectionId, organizationId },
        select: { id: true },
      })
    );
    if (!connection) {
      return null;
    }
    const records = await withDb((db) =>
      db.projectConnection.findMany({
        where: { organizationId, connectionId },
        include: { project: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      })
    );
    return records.map((record) => ({
      projectConnectionId: record.id,
      projectId: record.projectId,
      projectName: record.project.name,
      key: record.key,
      name: record.name,
    }));
  },
};

/** Bound of the organization-wide listing (projects × connections stays small). */
const PROJECT_CONNECTIONS_LIST_MAX = 1000;

const PROJECT_CONNECTION_INCLUDE = {
  connection: { select: { name: true, provider: true } },
} as const satisfies Prisma.ProjectConnectionInclude;

type ProjectConnectionRecord = Prisma.ProjectConnectionGetPayload<{
  include: typeof PROJECT_CONNECTION_INCLUDE;
}>;

/** A connection to add, with the source items it claims on its site. */
type PreparedEntry = {
  input: ProjectConnectionEntryInput;
  scopes: string[];
};

type ConflictQuery = {
  organizationId: string;
  projectId: string;
  connectionId: string;
  key: string;
  scopes: readonly string[];
};

async function projectExists(
  organizationId: string,
  projectId: string
): Promise<boolean> {
  const project = await withDb((db) =>
    db.project.findFirst({
      where: { id: projectId, organizationId },
      select: { id: true },
    })
  );
  return project !== null;
}

function findRecord(
  organizationId: string,
  projectId: string,
  projectConnectionId: string
): Promise<ProjectConnectionRecord | null> {
  return withDb((db) =>
    db.projectConnection.findFirst({
      where: { id: projectConnectionId, organizationId, projectId },
      include: PROJECT_CONNECTION_INCLUDE,
    })
  );
}

/**
 * The connections to add, all of one provider, with the settings parsed by
 * that provider and the source items each claims on its own site.
 */
async function prepareEntries(
  organizationId: string,
  input: CreateProjectConnectionsInput
): Promise<ServiceResult<{ settings: JsonObject; entries: PreparedEntry[] }>> {
  const loaded: Array<{
    input: ProjectConnectionEntryInput;
    connection: LoadedConnection;
  }> = [];
  for (const entry of input.connections) {
    const connection = await loadUsableConnection(
      organizationId,
      entry.connectionId
    );
    if (!connection.ok) {
      return connection;
    }
    loaded.push({ input: entry, connection: connection.value });
  }
  const providers = new Set(loaded.map((item) => item.connection.provider.key));
  if (providers.size > 1) {
    return serviceError(
      Status.BadRequest,
      "Add connections of one integration at a time: they share the project settings."
    );
  }
  let settings: JsonObject = {};
  const entries: PreparedEntry[] = [];
  for (const item of loaded) {
    const parsed = parseSettings(item.connection, input.settings);
    if (!parsed.ok) {
      return parsed;
    }
    settings = parsed.value.settings;
    entries.push({ input: item.input, scopes: parsed.value.scopes });
  }
  return Result.ok({ settings, entries });
}

function parseSettings(
  loaded: LoadedConnection,
  input: Record<string, unknown>
): ServiceResult<{ settings: JsonObject; scopes: string[] }> {
  const parsed = parseProjectSettings(loaded.provider, input);
  if (!parsed.ok) {
    return serviceError(Status.BadRequest, parsed.error);
  }
  return Result.ok({
    settings: parsed.value,
    scopes: projectScopeKeys(
      loaded.provider,
      loaded.runtime.config,
      parsed.value
    ),
  });
}

/**
 * The organization connection a project connection uses. Workflow-owned HTTP
 * endpoints and built-in providers are not offered to projects.
 */
async function loadUsableConnection(
  organizationId: string,
  connectionId: string
): Promise<ServiceResult<LoadedConnection>> {
  const loaded = await loadConnectionRuntime(organizationId, connectionId);
  if (!loaded) {
    return serviceError(
      Status.BadRequest,
      "The integration connection does not exist or cannot be loaded. Check it in Settings → Integrations."
    );
  }
  if (loaded.record.managedByWorkflowId !== null || loaded.provider.builtIn) {
    return serviceError(
      Status.BadRequest,
      `${loaded.provider.displayName} connections cannot be added to a project.`
    );
  }
  return Result.ok(loaded);
}

/** The first conflict as a user-facing message, else null. */
async function findConflict(
  tx: TransactionClient,
  query: ConflictQuery
): Promise<string | null> {
  const sameKey = await tx.projectConnection.findFirst({
    where: { projectId: query.projectId, key: query.key },
    select: { id: true },
  });
  if (sameKey) {
    return `The key "${query.key}" is already used in this project.`;
  }
  const sameConnection = await tx.projectConnection.findFirst({
    where: {
      projectId: query.projectId,
      connectionId: query.connectionId,
    },
    select: { key: true },
  });
  if (sameConnection) {
    return `This connection is already in the project as "${sameConnection.key}". A connection is one account: for another bot, add a connection for it in Settings → Integrations.`;
  }
  return await findScopeConflict(tx, query);
}

async function findScopeConflict(
  tx: TransactionClient,
  query: Pick<ConflictQuery, "organizationId" | "projectId" | "scopes">
): Promise<string | null> {
  if (query.scopes.length === 0) {
    return null;
  }
  // Only another project's claim conflicts: the project's own project
  // connections share items, one connection (one bot) each.
  const claimed = await tx.projectConnectionScope.findFirst({
    where: {
      organizationId: query.organizationId,
      scopeKey: { in: [...query.scopes] },
      projectConnection: { projectId: { not: query.projectId } },
    },
    select: {
      scopeKey: true,
      projectConnection: {
        select: { key: true, project: { select: { name: true } } },
      },
    },
  });
  if (!claimed) {
    return null;
  }
  const owner = claimed.projectConnection;
  return `${scopeContainer(claimed.scopeKey)} already belongs to "${owner.key}" in project ${owner.project.name}. Remove it there first.`;
}

async function replaceScopes(
  tx: TransactionClient,
  record: Pick<ProjectConnectionRecord, "id" | "organizationId">,
  scopes: readonly string[]
): Promise<void> {
  await tx.projectConnectionScope.deleteMany({
    where: { projectConnectionId: record.id },
  });
  if (scopes.length === 0) {
    return;
  }
  await tx.projectConnectionScope.createMany({
    data: scopes.map((scopeKey) => ({
      organizationId: record.organizationId,
      projectConnectionId: record.id,
      scopeKey,
    })),
  });
}

function toProjectConnectionDto(
  record: ProjectConnectionRecord
): ProjectConnection {
  return {
    id: record.id,
    projectId: record.projectId,
    connectionId: record.connectionId,
    connectionName: record.connection.name,
    provider: record.connection.provider,
    key: record.key,
    name: record.name,
    settings: toJsonObject(record.settings),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function lockOrganization(
  tx: TransactionClient,
  organizationId: string
): Promise<void> {
  const lockKey = `project-connections:${organizationId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
}

/** A unique index that fired despite the checks (a race) is a conflict too. */
async function writeGuarded<T>(
  write: () => Promise<ServiceResult<T>>
): Promise<ServiceResult<T>> {
  try {
    return await write();
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2003") {
      return serviceError(
        Status.Conflict,
        "A workflow started using this connection at the same time. Reload and try again."
      );
    }
    if (code === "P2002") {
      return serviceError(
        Status.Conflict,
        "Another change to this project's connections happened at the same time. Reload and try again."
      );
    }
    throw error;
  }
}

function serviceError<T>(
  status: StatusCode,
  message: string
): ServiceResult<T> {
  return Result.err({ status, message });
}

function notFound<T>(): ServiceResult<T> {
  return serviceError(Status.NotFound, "Project connection not found");
}

/**
 * What refers to a project connection's key: workflows with a trigger on it,
 * an action naming it or a grant listing it (in a workflow that runs in the
 * project), and agent steps of the project's process.
 */
async function findUsers(
  organizationId: string,
  projectId: string,
  key: string
): Promise<string[]> {
  const [workflows, process] = await Promise.all([
    withDb((db) =>
      db.workflow.findMany({
        where: {
          organizationId,
          OR: [{ projectId }, { triggers: { some: { projectId } } }],
        },
        select: {
          name: true,
          agentConfig: true,
          triggers: {
            where: { projectId },
            select: { projectConnection: { select: { key: true } } },
          },
          actions: { select: { connectionKey: true, config: true } },
        },
      })
    ),
    projectProcessService.findCurrent(organizationId, projectId),
  ]);
  const users = workflows
    .filter((workflow) => workflowUsesKey(workflow, key))
    .map((workflow) => `workflow "${workflow.name}"`);
  if (
    process.kind === CurrentProcessKind.Found &&
    processUsesKey(process.snapshot.definition, key)
  ) {
    users.push("the project's process");
  }
  return users;
}

function workflowUsesKey(
  workflow: {
    agentConfig: unknown;
    triggers: Array<{ projectConnection: { key: string } | null }>;
    actions: Array<{ connectionKey: string | null; config: unknown }>;
  },
  key: string
): boolean {
  if (
    workflow.triggers.some((trigger) => trigger.projectConnection?.key === key)
  ) {
    return true;
  }
  if (
    workflow.actions.some(
      (action) => action.connectionKey === key || grantsList(action.config, key)
    )
  ) {
    return true;
  }
  const agent = workflowAgentConfigSchema.safeParse(workflow.agentConfig);
  return agent.success && agent.data.process !== null
    ? processUsesKey(agent.data.process, key)
    : false;
}

function processUsesKey(process: ProjectProcess, key: string): boolean {
  return process.steps.some(
    (step) =>
      step.type === ProcessStepType.Agent &&
      Object.hasOwn(step.connections ?? {}, key)
  );
}

/** An action config whose `connections:` grant lists the key. */
function grantsList(config: unknown, key: string): boolean {
  const parsed = GRANTED_CONFIG_SCHEMA.safeParse(config);
  return parsed.success && Object.hasOwn(parsed.data.connections ?? {}, key);
}

const GRANTED_CONFIG_SCHEMA = z.object({
  connections: z.record(z.string(), z.unknown()).optional(),
});
