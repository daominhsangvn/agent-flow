import {
  type ConnectionGrants,
  normalizeConnectionGrants,
  SOURCE_CONNECTION_KEY,
} from "@repo/api/src/types/connection-grants";
import { withDb } from "@repo/database";
import { loadSourceConnection } from "@/lib/workflows/engine/source-connection";
import { loadProjectConnectionCatalog } from "../connection-grants";
import type { LoadedConnection } from "../connection-service";
import type { WorkflowRunSnapshot } from "../types";
import type {
  AgentToolSessionInput,
  GrantedConnection,
  RunPullRequestRef,
} from "./catalog";

/**
 * What an agent session's tools are computed from (catalog.ts): the run's
 * source connection and its project connection key, the grant, and the
 * granted project connections of the run's project. Used for the prompt when
 * the agent is dispatched and on every tool request, so both describe the
 * same tools.
 */
export async function loadAgentToolSession(input: {
  /** Who the tools serve, for the descriptions ("an instruction"). */
  agent: string;
  organizationId: string;
  runId: string;
  grants: ConnectionGrants | undefined;
  snapshot: WorkflowRunSnapshot;
}): Promise<{
  input: AgentToolSessionInput;
  sourceConnection: LoadedConnection | null;
} | null> {
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
      select: {
        organizationId: true,
        projectId: true,
        connectionId: true,
        projectConnectionId: true,
        projectConnection: { select: { key: true } },
      },
    })
  );
  if (!run) {
    return null;
  }
  const [sourceConnection, catalog] = await Promise.all([
    loadSourceConnection(run),
    loadProjectConnectionCatalog(input.organizationId, [run.projectId]),
  ]);
  const grants = normalizeConnectionGrants(input.grants);
  const connections = grants
    .filter((grant) => grant.key !== SOURCE_CONNECTION_KEY)
    .flatMap((grant): GrantedConnection[] => {
      const entry = catalog.find(run.projectId, grant.key);
      return entry
        ? [
            {
              key: entry.key,
              name: entry.name,
              provider: entry.provider,
              projectConnectionId: entry.id,
            },
          ]
        : [];
    });
  return {
    sourceConnection,
    input: {
      agent: input.agent,
      workflowName: input.snapshot.workflow.name,
      runUrl: input.snapshot.url,
      source: {
        ref: input.snapshot.source,
        provider: sourceConnection?.provider.key ?? null,
        key: run.projectConnection?.key ?? null,
      },
      grants,
      connections,
      pullRequests: runPullRequests(input.snapshot),
    },
  };
}

/** The run's pull requests, from its repositories (one per pushed repository). */
function runPullRequests(snapshot: WorkflowRunSnapshot): RunPullRequestRef[] {
  return snapshot.repositories.flatMap((repository) =>
    repository.pullRequest
      ? [
          {
            url: repository.pullRequest.url,
            number: repository.pullRequest.number,
            repository: repository.fullName,
            provider: repository.provider,
          },
        ]
      : []
  );
}
