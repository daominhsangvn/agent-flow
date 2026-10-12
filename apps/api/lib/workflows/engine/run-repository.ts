import type { RepoExecutionResult } from "@agentflow-ai/loops-api/execution-result";
import { Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type {
  ActionOutputs,
  RunRepositorySnapshot,
} from "@/lib/integrations/types";
import { readRunRepositories, toJsonObject } from "./run-data";

/**
 * The run's repositories (WorkflowRun.repository) and what actions report
 * back about them. Recorded when EXECUTE is launched: every project
 * repository the loop works in, as equals. EXECUTE's result then sets the
 * branch each one was pushed to, and actions such as "Create pull request"
 * act on the repositories with a branch through the connection that owns
 * them.
 */

const LOG_PREFIX = "[workflows/run-repository]";

export type RecordRunRepositoriesInput = {
  runId: string;
  organizationId: string;
  /** The loop's repositories, its first one first, with their base branches. */
  repos: Array<{ fullName: string; baseBranch: string }>;
};

/**
 * Stores the project repositories matching the loop's repositories on the
 * run, or clears them when the project has none. Best effort: a failure is
 * logged and leaves the run without repositories (repository actions then
 * skip).
 */
export async function recordRunRepositories(
  input: RecordRunRepositoriesInput
): Promise<void> {
  try {
    const repositories = await resolveRunRepositories(input);
    await writeRunRepositories(input.runId, input.organizationId, repositories);
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not record the run's repositories`, {
      runId: input.runId,
      error: parseError(error),
    });
  }
}

/**
 * Sets the branch each repository was pushed to from EXECUTE's per-repository
 * results; a repository without changes keeps no branch, so no pull request
 * is opened for it. Best effort, like recordRunRepositories.
 */
export async function recordRunRepositoryBranches(
  runId: string,
  organizationId: string,
  results: readonly RepoExecutionResult[]
): Promise<void> {
  if (results.length === 0) {
    return;
  }
  try {
    const run = await withDb((db) =>
      db.workflowRun.findFirst({
        where: { id: runId, organizationId },
        select: { repository: true },
      })
    );
    const { repositories } = readRunRepositories(run?.repository);
    if (repositories.length === 0) {
      return;
    }
    const byName = new Map(
      results.map((result) => [result.fullName.toLowerCase(), result])
    );
    const updated = repositories.map((repository) =>
      withExecutionResult(
        repository,
        byName.get(repository.fullName.toLowerCase())
      )
    );
    await writeRunRepositories(runId, organizationId, updated);
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not record the pushed branches`, {
      runId,
      error: parseError(error),
    });
  }
}

/**
 * Applies what an action reported: each pull request it opened is recorded
 * on its repository, and the first one becomes the run's pull request
 * (prUrl / branchName) unless the run already has one, so later actions see
 * it as {{pr.url}}. The run row is locked so two actions reporting at once
 * never overwrite each other's pull requests.
 */
export async function recordActionOutputs(
  runId: string,
  outputs: ActionOutputs | undefined
): Promise<void> {
  const pullRequests = outputs?.pullRequests ?? [];
  const first = pullRequests[0];
  if (!first) {
    return;
  }
  await withDb.tx(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM workflow_runs WHERE id = ${runId}::uuid FOR UPDATE`
    );
    const run = await tx.workflowRun.findUnique({
      where: { id: runId },
      select: { repository: true, prUrl: true },
    });
    if (!run) {
      return;
    }
    const opened = new Map(
      pullRequests.map((pullRequest) => [pullRequest.repositoryId, pullRequest])
    );
    const { repositories } = readRunRepositories(run.repository);
    const updated = repositories.map((repository) => {
      const pullRequest = opened.get(repository.id);
      return pullRequest
        ? {
            ...repository,
            pullRequest: { url: pullRequest.url, number: pullRequest.number },
          }
        : repository;
    });
    await tx.workflowRun.update({
      where: { id: runId },
      data: {
        repository: toRepositoriesJson(updated),
        ...(run.prUrl ? {} : { prUrl: first.url, branchName: first.branch }),
      },
    });
  });
}

function withExecutionResult(
  repository: RunRepositorySnapshot,
  result: RepoExecutionResult | undefined
): RunRepositorySnapshot {
  if (result?.status === "pushed") {
    return {
      ...repository,
      branch: result.branchName,
      baseBranch: result.baseBranch || repository.baseBranch,
    };
  }
  if (result?.status === "success") {
    // Opened by the agent itself (a loop that is not push-only).
    return {
      ...repository,
      branch: result.branchName,
      baseBranch: result.baseBranch || repository.baseBranch,
      pullRequest: { url: result.prUrl, number: result.prNumber },
    };
  }
  return { ...repository, branch: null };
}

async function writeRunRepositories(
  runId: string,
  organizationId: string,
  repositories: RunRepositorySnapshot[]
): Promise<void> {
  await withDb((db) =>
    db.workflowRun.updateMany({
      where: { id: runId, organizationId },
      data: {
        repository:
          repositories.length > 0
            ? toRepositoriesJson(repositories)
            : Prisma.DbNull,
      },
    })
  );
}

function toRepositoriesJson(
  repositories: RunRepositorySnapshot[]
): Prisma.InputJsonArray {
  return repositories.map((repository) => toJsonObject(repository));
}

async function resolveRunRepositories(
  input: RecordRunRepositoriesInput
): Promise<RunRepositorySnapshot[]> {
  const { organizationId } = input;
  if (input.repos.length === 0) {
    return [];
  }
  const run = await withDb((db) =>
    db.workflowRun.findFirst({
      where: { id: input.runId, organizationId },
      select: { workflow: { select: { projectId: true } } },
    })
  );
  const projectId = run?.workflow.projectId;
  if (!projectId) {
    return [];
  }
  const rows = await withDb((db) =>
    db.projectRepository.findMany({
      where: { organizationId, projectId, connectionId: { not: null } },
      orderBy: { createdAt: "asc" },
    })
  );
  const byName = new Map(rows.map((row) => [row.fullName.toLowerCase(), row]));
  const repositories: RunRepositorySnapshot[] = [];
  const seen = new Set<string>();
  for (const repo of input.repos) {
    const row = byName.get(repo.fullName.toLowerCase());
    if (!row?.connectionId || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    repositories.push({
      id: row.id,
      connectionId: row.connectionId,
      provider: row.provider,
      externalId: row.externalId,
      fullName: row.fullName,
      webUrl: row.webUrl,
      cloneUrl: row.cloneUrl,
      defaultBranch: row.defaultBranch,
      branch: null,
      baseBranch: repo.baseBranch || row.defaultBranch || "",
      pullRequest: null,
    });
  }
  return repositories;
}
