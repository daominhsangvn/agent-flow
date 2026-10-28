import { randomUUID } from "node:crypto";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import type { ProjectProcessState } from "@repo/api/src/types/project-process";
import { readProjectRunnerIds } from "@repo/api/src/types/project-runners";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type RequestRunnerCapabilitiesRefreshInput,
  RUNNER_CAPABILITIES_REFRESH_OPERATION_ID,
  RUNNER_CAPABILITIES_REFRESH_TIMEOUT_MS,
  type RunnerCapabilitiesRefresh,
  RunnerCapabilitiesRefreshStatus,
  RunnerCapabilitiesSource,
  runnerCapabilitiesRefreshKey,
  runnerCapabilitiesRefreshRequestSchema,
  runnerCapabilitiesRefreshResultSchema,
  runnerCapabilitiesSchema,
} from "@repo/api/src/types/runner-capabilities";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { resolveOrgProjectId } from "@/app/compute-targets/capabilities-service";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  type CurrentProcess,
  CurrentProcessKind,
  projectProcessService,
} from "@/app/projects/project-process-service";
import {
  checkoutBaseBranch,
  findRepositoryCheckout,
  listProjectRepositoryCheckouts,
} from "@/app/projects/project-repository-checkouts";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import type { GitCredential } from "@/lib/integrations/types";
import {
  dispatchCapabilitiesRefresh,
  isCommandSigningRefusedError,
  isDispatchError,
} from "@/lib/loops/loop-desktop";
import {
  type GitCredentialError,
  type GitCredentialRequest,
  issueRepositoryGitCredential,
  matchesGitCredentialRequest,
} from "@/lib/loops/loop-git-credential";
import { waitUntil } from "@/lib/wait-until";

/**
 * Asks an auto runner to read AGENTFLOW.md from a project's toolkit
 * repository (operation `capabilities_refresh`) and reports how that read
 * went. A refresh is identified by its id, kept in the command's
 * idempotency key, so no table is needed.
 */

export type CapabilitiesRefreshError = { status: StatusCode; message: string };

type RunnerTarget = {
  id: string;
  organizationId: string;
  machineName: string;
  isOnline: boolean;
  capabilities: unknown;
};

const refreshFlagSchema = z.object({
  toolkitCapabilitiesRefresh: z.literal(true),
});
const personalRunnerSchema = z.object({ personalRunner: z.object({}) });

const TOOLKIT_REFRESH_STALE_MS = 20 * 60 * 60_000;
const TOOLKIT_REFRESH_BATCH_MAX = 100;
const ACTIVE_COMMAND_STATUSES = [
  DesktopCommandStatus.Queued,
  DesktopCommandStatus.Accepted,
  DesktopCommandStatus.Running,
];

/** The command's own limit (timeout plus the dispatch grace) and a margin for queueing. */
export const REFRESH_COMMAND_WINDOW_MS =
  RUNNER_CAPABILITIES_REFRESH_TIMEOUT_MS + 2 * 60_000;
const REFRESH_OVERDUE_ERROR =
  "The runner did not finish reading the toolkit in time.";

type RefreshCounts = { dispatched: number; skipped: number };

export const computeTargetCapabilitiesRefreshService = {
  async request(
    organizationId: string,
    computeTargetId: string,
    input: RequestRunnerCapabilitiesRefreshInput
  ): Promise<Result<RunnerCapabilitiesRefresh, CapabilitiesRefreshError>> {
    const projectId = await resolveOrgProjectId(input.project, organizationId);
    if (!projectId) {
      return refreshError(Status.NotFound, "Project not found");
    }
    return requestFor(
      organizationId,
      computeTargetId,
      projectId,
      input.repository
    );
  },

  async status(
    organizationId: string,
    computeTargetId: string,
    refreshId: string
  ): Promise<RunnerCapabilitiesRefresh | null> {
    const row = await withDb((db) =>
      db.desktopCommand.findFirst({
        where: {
          computeTargetId,
          idempotencyKey: runnerCapabilitiesRefreshKey(refreshId),
          operationId: RUNNER_CAPABILITIES_REFRESH_OPERATION_ID,
          computeTarget: { organizationId },
        },
        select: {
          id: true,
          status: true,
          error: true,
          requestPayload: true,
          createdAt: true,
        },
      })
    );
    if (!row) {
      return null;
    }
    const body = parseRefreshBody(row.requestPayload);
    if (!body) {
      return null;
    }
    const { status, error } = await resolveRefreshOutcome(computeTargetId, row);
    return {
      refreshId,
      computeTargetId,
      projectId: body.projectId,
      repository: body.repository,
      status,
      error,
    };
  },

  /**
   * A git credential for the one repository a running refresh names; only the
   * runner's owner (the API key on the runner) gets one.
   */
  async issueGitCredential(
    organizationId: string,
    userId: string,
    computeTargetId: string,
    refreshId: string,
    request: GitCredentialRequest
  ): Promise<Result<GitCredential, GitCredentialError>> {
    const row = await withDb((db) =>
      db.desktopCommand.findFirst({
        where: {
          computeTargetId,
          idempotencyKey: runnerCapabilitiesRefreshKey(refreshId),
          operationId: RUNNER_CAPABILITIES_REFRESH_OPERATION_ID,
          status: { in: ACTIVE_COMMAND_STATUSES },
          createdAt: { gte: new Date(Date.now() - REFRESH_COMMAND_WINDOW_MS) },
          computeTarget: { organizationId, userId },
        },
        select: { requestPayload: true },
      })
    );
    const body = row ? parseRefreshBody(row.requestPayload) : null;
    const wanted = body?.repository.toLowerCase();
    const checkout = body
      ? (
          await listProjectRepositoryCheckouts(organizationId, body.projectId)
        ).find(
          (candidate) =>
            candidate.fullName.toLowerCase() === wanted &&
            matchesGitCredentialRequest(candidate.cloneUrl, request)
        )
      : undefined;
    if (!checkout) {
      return Result.err({
        status: Status.NotFound,
        message: "No running toolkit read of this runner matches the request",
      });
    }
    return issueRepositoryGitCredential({
      organizationId,
      repository: checkout,
      logContext: { refreshId },
    });
  },

  /** Refreshes the runners that read a toolkit for the project, or are assigned to it. */
  async refreshProject(
    organizationId: string,
    projectId: string
  ): Promise<RefreshCounts> {
    const { rows, project } = await withDb(async (db) => ({
      rows: await db.computeTargetCapabilities.findMany({
        where: {
          organizationId,
          projectId,
          source: RunnerCapabilitiesSource.Toolkit,
        },
        select: { computeTargetId: true },
      }),
      project: await db.project.findFirst({
        where: { id: projectId, organizationId },
        select: { settings: true },
      }),
    }));
    const targetIds = new Set([
      ...rows.map((row) => row.computeTargetId),
      ...readProjectRunnerIds(project?.settings),
    ]);
    const counts: RefreshCounts = { dispatched: 0, skipped: 0 };
    for (const targetId of targetIds) {
      await refreshOne(counts, organizationId, targetId, projectId);
    }
    return counts;
  },

  /** Refreshes toolkit files not uploaded for 20 hours (the daily cron). */
  async refreshStale(now: Date): Promise<RefreshCounts> {
    const rows = await withDb((db) =>
      db.computeTargetCapabilities.findMany({
        where: {
          source: RunnerCapabilitiesSource.Toolkit,
          uploadedAt: {
            lt: new Date(now.getTime() - TOOLKIT_REFRESH_STALE_MS),
          },
        },
        orderBy: { uploadedAt: "asc" },
        take: TOOLKIT_REFRESH_BATCH_MAX,
        select: {
          organizationId: true,
          computeTargetId: true,
          projectId: true,
        },
      })
    );
    const counts: RefreshCounts = { dispatched: 0, skipped: 0 };
    for (const row of rows) {
      await refreshOne(
        counts,
        row.organizationId,
        row.computeTargetId,
        row.projectId
      );
    }
    return counts;
  },

  /** After a process save that changed the toolkit, refresh in the background. */
  refreshAfterProcessSave(
    organizationId: string,
    projectId: string,
    before: CurrentProcess,
    after: ProjectProcessState
  ): void {
    if (
      processToolkitChanged(before, after) &&
      after.current?.definition?.toolkit
    ) {
      waitUntil(
        computeTargetCapabilitiesRefreshService.refreshProject(
          organizationId,
          projectId
        )
      );
    }
  },
};

/** Why a runner cannot read a toolkit now; null when it can. */
export function refreshRefusal(
  target: Pick<RunnerTarget, "machineName" | "isOnline" | "capabilities">
): CapabilitiesRefreshError | null {
  if (personalRunnerSchema.safeParse(target.capabilities).success) {
    return {
      status: Status.BadRequest,
      message: `${target.machineName} is a personal runner: it reads AGENTFLOW.md from its project folder and uploads it itself.`,
    };
  }
  if (!refreshFlagSchema.safeParse(target.capabilities).success) {
    return {
      status: Status.Conflict,
      message: `${target.machineName} runs a runner version that cannot read AGENTFLOW.md from a toolkit. Update the runner, or upload the file with PUT /compute-targets/{id}/capabilities.`,
    };
  }
  if (!target.isOnline) {
    return {
      status: Status.Conflict,
      message: `${target.machineName} is offline.`,
    };
  }
  return null;
}

async function requestFor(
  organizationId: string,
  computeTargetId: string,
  projectId: string,
  explicitRepository?: string
): Promise<Result<RunnerCapabilitiesRefresh, CapabilitiesRefreshError>> {
  const target = await computeTargetsService.findById(computeTargetId);
  if (!target || target.organizationId !== organizationId) {
    return refreshError(Status.NotFound, "Runner not found");
  }
  const refusal = refreshRefusal(target);
  if (refusal) {
    return Result.err(refusal);
  }
  const repository = await resolveToolkitRepository({
    organizationId,
    computeTargetId,
    projectId,
    machineName: target.machineName,
    explicitRepository,
  });
  if (!repository.ok) {
    return Result.err(repository.error);
  }
  const checkout = findRepositoryCheckout(
    await listProjectRepositoryCheckouts(organizationId, projectId),
    repository.value
  );
  if (!checkout) {
    return refreshError(
      Status.BadRequest,
      `The toolkit repository ${repository.value} is not one of the project's repositories.`
    );
  }
  const refreshId = randomUUID();
  try {
    await dispatchCapabilitiesRefresh({
      computeTargetId,
      request: {
        refreshId,
        projectId,
        repository: checkout.fullName,
        cloneUrl: checkout.cloneUrl,
        defaultBranch: checkoutBaseBranch(checkout),
      },
    });
  } catch (err) {
    if (isDispatchError(err)) {
      await desktopCommandStore.markCommandExpired(
        err.commandId,
        "capabilities_refresh_not_delivered",
        { commandId: err.commandId, computeTargetId }
      );
      return refreshError(Status.BadGateway, err.message);
    }
    if (isCommandSigningRefusedError(err)) {
      return refreshError(Status.Conflict, err.message);
    }
    throw err;
  }
  return Result.ok({
    refreshId,
    computeTargetId,
    projectId,
    repository: checkout.fullName,
    status: RunnerCapabilitiesRefreshStatus.Pending,
    error: null,
  });
}

/** Explicit repository, else the runner's stored file, else the process toolkit. */
async function resolveToolkitRepository(input: {
  organizationId: string;
  computeTargetId: string;
  projectId: string;
  machineName: string;
  explicitRepository?: string;
}): Promise<Result<string, CapabilitiesRefreshError>> {
  if (input.explicitRepository) {
    return Result.ok(input.explicitRepository);
  }
  const stored = await withDb((db) =>
    db.computeTargetCapabilities.findUnique({
      where: {
        computeTargetId_projectId: {
          computeTargetId: input.computeTargetId,
          projectId: input.projectId,
        },
      },
      select: { organizationId: true, capabilities: true },
    })
  );
  if (stored?.organizationId === input.organizationId) {
    const parsed = runnerCapabilitiesSchema.safeParse(stored.capabilities);
    const fromFile = parsed.success ? parsed.data.toolkit?.repository : null;
    if (fromFile) {
      return Result.ok(fromFile);
    }
  }
  const current = await projectProcessService.findCurrent(
    input.organizationId,
    input.projectId
  );
  const fromProcess =
    current.kind === CurrentProcessKind.Found
      ? current.snapshot.definition.toolkit?.repository
      : null;
  if (fromProcess) {
    return Result.ok(fromProcess);
  }
  return refreshError(
    Status.BadRequest,
    `Name the toolkit repository: ${input.machineName} has no AGENTFLOW.md from a toolkit for this project yet, and the project's process has no toolkit.`
  );
}

function parseRefreshBody(requestPayload: unknown) {
  const payload = z.object({ body: z.unknown() }).safeParse(requestPayload);
  if (!payload.success) {
    return null;
  }
  const body = runnerCapabilitiesRefreshRequestSchema.safeParse(
    payload.data.body
  );
  return body.success ? body.data : null;
}

async function resolveRefreshOutcome(
  computeTargetId: string,
  row: { id: string; status: string; error: string | null; createdAt: Date }
): Promise<{
  status: RunnerCapabilitiesRefreshStatus;
  error: string | null;
}> {
  if (row.status === DesktopCommandStatus.Done) {
    return await readRefreshResult(computeTargetId, row.id);
  }
  const ended: string[] = [
    DesktopCommandStatus.Failed,
    DesktopCommandStatus.Cancelled,
    DesktopCommandStatus.Expired,
  ];
  if (ended.includes(row.status)) {
    return {
      status: RunnerCapabilitiesRefreshStatus.Failed,
      error:
        row.error ?? `The runner did not read the toolkit (${row.status}).`,
    };
  }
  if (Date.now() - row.createdAt.getTime() > REFRESH_COMMAND_WINDOW_MS) {
    await desktopCommandStore.markCommandExpired(
      row.id,
      "capabilities_refresh_wait_exceeded",
      { commandId: row.id, computeTargetId }
    );
    return {
      status: RunnerCapabilitiesRefreshStatus.Failed,
      error: REFRESH_OVERDUE_ERROR,
    };
  }
  return { status: RunnerCapabilitiesRefreshStatus.Pending, error: null };
}

async function readRefreshResult(
  computeTargetId: string,
  commandId: string
): Promise<{
  status: RunnerCapabilitiesRefreshStatus;
  error: string | null;
}> {
  const events =
    (await desktopCommandStore.getCommandEvents(computeTargetId, commandId)) ??
    [];
  for (const event of [...events].reverse()) {
    if (event.eventType !== "result") {
      continue;
    }
    const parsed = runnerCapabilitiesRefreshResultSchema.safeParse(event.data);
    if (parsed.success) {
      return parsed.data.ok
        ? { status: RunnerCapabilitiesRefreshStatus.Succeeded, error: null }
        : {
            status: RunnerCapabilitiesRefreshStatus.Failed,
            error: parsed.data.error,
          };
    }
  }
  return {
    status: RunnerCapabilitiesRefreshStatus.Failed,
    error: "The runner finished without an answer.",
  };
}

function refreshError<T>(
  status: StatusCode,
  message: string
): Result<T, CapabilitiesRefreshError> {
  return Result.err({ status, message });
}

async function refreshOne(
  counts: RefreshCounts,
  organizationId: string,
  computeTargetId: string,
  projectId: string
): Promise<void> {
  let reason: string | null = null;
  try {
    const result = await requestFor(organizationId, computeTargetId, projectId);
    if (result.ok) {
      counts.dispatched += 1;
      return;
    }
    reason = result.error.message;
  } catch (err) {
    // A batch must go on past a runner that fails unexpectedly.
    reason = err instanceof Error ? err.message : String(err);
  }
  counts.skipped += 1;
  log.info("[capabilities-refresh] Skipped a runner", {
    computeTargetId,
    projectId,
    reason,
  });
}

/** True when the process toolkit's repository or mounts differ. */
export function processToolkitChanged(
  before: CurrentProcess,
  after: ProjectProcessState
): boolean {
  const previous =
    before.kind === CurrentProcessKind.Found
      ? before.snapshot.definition.toolkit
      : null;
  const next = after.current?.definition?.toolkit ?? null;
  return toolkitSignature(previous) !== toolkitSignature(next);
}

function toolkitSignature(
  toolkit: { repository: string; mounts?: unknown } | null | undefined
): string {
  if (!toolkit) {
    return "";
  }
  return JSON.stringify({
    repository: toolkit.repository.toLowerCase(),
    mounts: toolkit.mounts ?? null,
  });
}
