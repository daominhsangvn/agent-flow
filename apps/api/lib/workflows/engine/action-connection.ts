import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import { WORKFLOW_INSTRUCTION_ACTION_TYPE } from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { listProjectRepositoryCheckouts } from "@/app/projects/project-repository-checkouts";
import {
  type LoadedConnection,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import { loadProjectConnectionRuntime } from "@/lib/integrations/project-connections";
import {
  findActionDefinition,
  isRepositoryScopedActionType,
} from "@/lib/integrations/registry";
import { readRunRepositories } from "./run-data";

/**
 * The connections an action of a run works through (docs/workflows.md
 * "Actions"). Project connections are named by key and resolved in the run's
 * project; the run's source connection is the project connection whose item
 * started it.
 *
 * - The workflow's built-in HTTPS call works on its managed connection.
 * - An action naming a key works on that project connection. An action on
 *   the source item (a comment, a transition) only runs for runs from that
 *   connection: it is skipped for runs from another one, never re-routed, so
 *   an item key in the ticket text can never send it elsewhere.
 * - Without a key: an instruction and a source item action work on the
 *   run's source connection; a repository-scoped action ("Create pull
 *   request") on every connection that owns one of the run's repositories;
 *   any other type on the project's only connection that offers it.
 *
 * Project connections come with their effective runtime (their own account
 * when they have one). Every failure is a reason to skip the action, written
 * for the run page.
 */

export type ActionConnectionResult =
  | { ok: true; connections: [LoadedConnection, ...LoadedConnection[]] }
  | { ok: false; reason: string };

export async function resolveActionConnection(input: {
  organizationId: string;
  runId: string;
  action: {
    connectionId: string | null;
    connectionKey: string | null;
    type: string;
  };
}): Promise<ActionConnectionResult> {
  const { organizationId, action } = input;
  if (action.connectionId) {
    return await loadUsableConnections(organizationId, [action.connectionId]);
  }
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: input.runId, organizationId },
      select: {
        connectionId: true,
        projectId: true,
        projectConnectionId: true,
        repository: true,
      },
    })
  );
  if (!run) {
    return { ok: false, reason: "The run no longer exists." };
  }
  const context: RunContext = { organizationId, ...run };
  if (action.connectionKey) {
    return await resolveKeyedAction(context, {
      key: action.connectionKey,
      type: action.type,
    });
  }
  if (action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return await resolveSource(context);
  }
  return await resolveAutomaticAction(context, action.type);
}

type RunContext = {
  organizationId: string;
  connectionId: string | null;
  projectId: string;
  projectConnectionId: string | null;
  repository: unknown;
};

const NO_SOURCE_CONNECTION_REASON =
  "The run was not started by an integration trigger, so it has no source connection to work on.";

/** The run's source: its project connection, else the trigger's own connection (built-in HTTP). */
async function resolveSource(run: RunContext): Promise<ActionConnectionResult> {
  if (run.projectConnectionId) {
    return await loadProjectConnection(run, run.projectConnectionId);
  }
  return run.connectionId
    ? await loadUsableConnections(run.organizationId, [run.connectionId])
    : { ok: false, reason: NO_SOURCE_CONNECTION_REASON };
}

async function resolveKeyedAction(
  run: RunContext,
  action: { key: string; type: string }
): Promise<ActionConnectionResult> {
  const named = await withDb((db) =>
    db.projectConnection.findFirst({
      where: {
        organizationId: run.organizationId,
        projectId: run.projectId,
        key: action.key,
      },
      select: { id: true, connection: { select: { provider: true } } },
    })
  );
  if (!named) {
    return {
      ok: false,
      reason: `The run's project has no connection "${action.key}".`,
    };
  }
  const definition = findActionDefinition(
    named.connection.provider,
    action.type
  );
  if (definition?.sourceOperation && named.id !== run.projectConnectionId) {
    return {
      ok: false,
      reason: `This action works on the source item of runs from "${action.key}"; this run came from another connection.`,
    };
  }
  return await loadProjectConnection(run, named.id);
}

/**
 * No key: the source when its provider offers the type on the source item,
 * the repositories' connections for a repository-scoped type (whether or not
 * they are connections of the project), else the project's only connection
 * that offers it.
 */
async function resolveAutomaticAction(
  run: RunContext,
  type: string
): Promise<ActionConnectionResult> {
  const source = await loadSourceProvider(run);
  const sourceDefinition = source
    ? findActionDefinition(source.provider, type)
    : null;
  if (sourceDefinition?.sourceOperation) {
    return await resolveSource(run);
  }
  if (isRepositoryScopedActionType(type)) {
    return await resolveRepositoryAction(run, type);
  }
  const candidates = await listProjectCandidates(run, type);
  const [first] = candidates;
  if (!first) {
    return {
      ok: false,
      reason: `No connection of the run's project offers "${type}". Name one for the action.`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `Several connections of the run's project offer "${type}" (${candidates.map((candidate) => candidate.key).join(", ")}). Name one for the action.`,
    };
  }
  return await loadProjectConnection(run, first.id);
}

async function loadSourceProvider(
  run: RunContext
): Promise<{ provider: string } | null> {
  if (!run.projectConnectionId) {
    return null;
  }
  const row = await withDb((db) =>
    db.projectConnection.findFirst({
      where: {
        id: run.projectConnectionId ?? "",
        organizationId: run.organizationId,
      },
      select: { connection: { select: { provider: true } } },
    })
  );
  return row ? { provider: row.connection.provider } : null;
}

/** The project's connections whose provider offers the type. */
async function listProjectCandidates(
  run: RunContext,
  type: string
): Promise<Array<{ id: string; key: string; provider: string }>> {
  const rows = await withDb((db) =>
    db.projectConnection.findMany({
      where: { organizationId: run.organizationId, projectId: run.projectId },
      select: {
        id: true,
        key: true,
        connection: { select: { provider: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  );
  return rows
    .map((row) => ({
      id: row.id,
      key: row.key,
      provider: row.connection.provider,
    }))
    .filter((row) => findActionDefinition(row.provider, type));
}

/**
 * A pull request on every connection that owns one of the run's
 * repositories and offers the type; the project's first repository
 * connection when none of them holds one yet (the action itself then says
 * why it has nothing to do).
 */
async function resolveRepositoryAction(
  run: RunContext,
  type: string
): Promise<ActionConnectionResult> {
  const checkouts = await listProjectRepositoryCheckouts(
    run.organizationId,
    run.projectId
  );
  const offering = [
    ...new Set(
      checkouts.flatMap((checkout) =>
        checkout.connectionId && findActionDefinition(checkout.provider, type)
          ? [checkout.connectionId]
          : []
      )
    ),
  ];
  if (offering.length === 0) {
    return {
      ok: false,
      reason: `No repository connection of the run's project offers "${type}".`,
    };
  }
  const owners = new Set(
    readRunRepositories(run.repository).repositories.map(
      (repository) => repository.connectionId
    )
  );
  const owning = offering.filter((id) => owners.has(id));
  return await loadUsableConnections(
    run.organizationId,
    owning.length > 0 ? owning : offering.slice(0, 1)
  );
}

async function loadProjectConnection(
  run: RunContext,
  projectConnectionId: string
): Promise<ActionConnectionResult> {
  const loaded = await loadProjectConnectionRuntime(
    run.organizationId,
    projectConnectionId
  );
  if (!loaded) {
    return {
      ok: false,
      reason:
        "The project connection was removed, its account must be entered again, or its credentials can no longer be read.",
    };
  }
  const problem = unusableReason(loaded.connection);
  return problem
    ? { ok: false, reason: problem }
    : { ok: true, connections: [loaded.connection] };
}

/**
 * The connections that can still be used; the first one's problem when none
 * can (removed, unreadable credentials, disabled).
 */
async function loadUsableConnections(
  organizationId: string,
  connectionIds: readonly string[]
): Promise<ActionConnectionResult> {
  const connections: LoadedConnection[] = [];
  let reason: string | null = null;
  for (const connectionId of connectionIds) {
    const loaded = await loadConnectionRuntime(organizationId, connectionId);
    const problem = unusableReason(loaded);
    if (loaded && !problem) {
      connections.push(loaded);
    } else {
      reason ??= problem;
    }
  }
  const [first, ...rest] = connections;
  return first
    ? { ok: true, connections: [first, ...rest] }
    : { ok: false, reason: reason ?? "No usable connection." };
}

function unusableReason(loaded: LoadedConnection | null): string | null {
  if (!loaded) {
    return "The connection was removed or its credentials can no longer be read.";
  }
  if (loaded.record.status === IntegrationConnectionStatus.Disabled) {
    return `The connection "${loaded.record.name}" is disabled.`;
  }
  return null;
}
