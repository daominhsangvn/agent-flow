import {
  type ProjectRunner,
  type ProjectRunners,
  readProjectRunnerIds,
  type UpdateProjectRunnersInput,
} from "@repo/api/src/types/project-runners";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { z } from "zod";
import { countActiveLoopsByTarget } from "./project-runner-selection";

/**
 * Runners of a project (Project → Repositories → Runners): the compute targets
 * its agent loops run on, stored as `runnerIds` in the project's `settings`
 * and written with a single jsonb update, so the other settings keys are kept.
 * Loops pick one through project-runner-selection.ts.
 */

export type ProjectRunnersServiceError = {
  status: StatusCode;
  message: string;
};

const capabilitiesSchema = z.object({
  maxInFlightCommands: z.number().int().positive().optional(),
  versions: z.record(z.string(), z.string()).optional(),
  toolchains: z.record(z.string(), z.string()).optional(),
});

export const projectRunnersService = {
  /** Null when the project does not exist in the organization. */
  async get(
    organizationId: string,
    projectId: string
  ): Promise<ProjectRunners | null> {
    const project = await withDb((db) =>
      db.project.findFirst({
        where: { id: projectId, organizationId },
        select: { settings: true },
      })
    );
    if (!project) {
      return null;
    }
    return {
      runners: await loadRunners(
        organizationId,
        readProjectRunnerIds(project.settings)
      ),
    };
  },

  /**
   * Replaces the project's runners. Each must be a computer of the
   * organization the caller can dispatch to (their own, or one shared with the
   * organization).
   */
  async update(
    organizationId: string,
    userId: string,
    projectId: string,
    input: UpdateProjectRunnersInput
  ): Promise<Result<ProjectRunners, ProjectRunnersServiceError>> {
    const runnerIds = [...new Set(input.runnerIds)];
    const accessible = await withDb((db) =>
      db.computeTarget.findMany({
        where: {
          id: { in: runnerIds },
          organizationId,
          isCloudSentinel: false,
          OR: [{ userId }, { isSharedWithOrg: true }],
        },
        select: { id: true },
      })
    );
    if (accessible.length !== runnerIds.length) {
      return serviceError(
        Status.BadRequest,
        "Choose computers of this organization that you own or that are shared with it"
      );
    }
    const updated = await withDb(
      (db) =>
        db.$executeRaw`
        UPDATE projects
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{runnerIds}', ${JSON.stringify(runnerIds)}::jsonb),
            updated_at = NOW()
        WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid`
    );
    if (updated === 0) {
      return serviceError(Status.NotFound, "Project not found");
    }
    return Result.ok({
      runners: await loadRunners(organizationId, runnerIds),
    });
  },
};

/** The runners in `runnerIds` order; computers deleted since are left out. */
async function loadRunners(
  organizationId: string,
  runnerIds: string[]
): Promise<ProjectRunner[]> {
  if (runnerIds.length === 0) {
    return [];
  }
  const [targets, activeLoops] = await Promise.all([
    withDb((db) =>
      db.computeTarget.findMany({
        where: { id: { in: runnerIds }, organizationId },
        select: {
          id: true,
          machineName: true,
          isOnline: true,
          isSharedWithOrg: true,
          capabilities: true,
          user: { select: { firstName: true, lastName: true } },
        },
      })
    ),
    countActiveLoopsByTarget(organizationId, runnerIds),
  ]);
  const byId = new Map(targets.map((target) => [target.id, target]));
  return runnerIds.flatMap((id) => {
    const target = byId.get(id);
    if (!target) {
      return [];
    }
    const capabilities = capabilitiesSchema.safeParse(target.capabilities);
    const ownerName = [target.user?.firstName, target.user?.lastName]
      .filter(Boolean)
      .join(" ");
    return [
      {
        id: target.id,
        machineName: target.machineName,
        isOnline: target.isOnline,
        isSharedWithOrg: target.isSharedWithOrg,
        ownerName: ownerName || null,
        capacity: capabilities.success
          ? (capabilities.data.maxInFlightCommands ?? null)
          : null,
        activeLoops: activeLoops.get(id) ?? 0,
        tools: capabilities.success
          ? {
              ...capabilities.data.versions,
              ...capabilities.data.toolchains,
            }
          : {},
      },
    ];
  });
}

function serviceError<T>(
  status: StatusCode,
  message: string
): Result<T, ProjectRunnersServiceError> {
  return Result.err({ status, message });
}
