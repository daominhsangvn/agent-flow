import { createHash } from "node:crypto";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type ComputeTargetCapabilities,
  parseRunnerCapabilitiesMarkdown,
  RunnerCapabilitiesSource,
  runnerCapabilitiesSchema,
  type UploadRunnerCapabilitiesInput,
} from "@repo/api/src/types/runner-capabilities";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { resolveProjectId } from "@/lib/identifier-utils";

/**
 * Runners' `AGENTFLOW.md` files (docs/runner.md "Capabilities
 * (AGENTFLOW.md)"): what each runner declares it can do for a project. A runner
 * uploads its file with its owner's API key; the API parses the front matter
 * itself (the runner's parse only decides its local warnings) and keeps one
 * file per runner and project.
 */

const WITH_RUNNER = {
  computeTarget: { select: { machineName: true, isOnline: true } },
} as const;

type CapabilitiesRow = Prisma.ComputeTargetCapabilitiesGetPayload<{
  include: typeof WITH_RUNNER;
}>;

const stringListSchema = z.array(z.string());
const sourceSchema = z
  .enum(RunnerCapabilitiesSource)
  .catch(RunnerCapabilitiesSource.Personal);

export const computeTargetCapabilitiesService = {
  /**
   * Stores a runner's file for a project. Only the runner's owner uploads
   * (the runner calls with its owner's API key), and the project must be one
   * of the organization's.
   */
  async upload(
    organizationId: string,
    userId: string,
    computeTargetId: string,
    input: UploadRunnerCapabilitiesInput
  ): Promise<Result<ComputeTargetCapabilities, StatusCode>> {
    const projectId = await resolveOrgProjectId(input.project, organizationId);
    if (!projectId) {
      return Result.err(Status.NotFound);
    }
    const parsed = parseRunnerCapabilitiesMarkdown(input.content);
    const columns = {
      organizationId,
      source: input.source,
      content: input.content,
      capabilities: parsed.ok
        ? (parsed.value as Prisma.InputJsonValue)
        : Prisma.DbNull,
      problems: parsed.ok ? [] : parsed.problems,
      warnings: input.warnings,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      uploadedAt: new Date(),
    };
    const row = await withDb.tx(async (tx) => {
      const target = await tx.computeTarget.findFirst({
        where: { id: computeTargetId, organizationId, userId },
        select: { id: true },
      });
      if (!target) {
        return null;
      }
      return tx.computeTargetCapabilities.upsert({
        where: { computeTargetId_projectId: { computeTargetId, projectId } },
        create: { ...columns, computeTargetId, projectId },
        update: columns,
        include: WITH_RUNNER,
      });
    });
    return row ? Result.ok(toCapabilities(row)) : Result.err(Status.NotFound);
  },

  /** A runner's files (one per project), for anyone who can see the runner. */
  async listForTarget(
    organizationId: string,
    userId: string,
    computeTargetId: string
  ): Promise<ComputeTargetCapabilities[] | null> {
    const rows = await withDb(async (db) => {
      const target = await db.computeTarget.findFirst({
        where: {
          id: computeTargetId,
          organizationId,
          OR: [{ userId }, { isSharedWithOrg: true }],
        },
        select: { id: true },
      });
      if (!target) {
        return null;
      }
      return db.computeTargetCapabilities.findMany({
        where: { organizationId, computeTargetId },
        orderBy: { uploadedAt: "desc" },
        include: WITH_RUNNER,
      });
    });
    return rows ? rows.map(toCapabilities) : null;
  },

  /** Every runner's file for a project (the orchestrator's runner catalog). */
  async listForProject(
    organizationId: string,
    projectId: string
  ): Promise<ComputeTargetCapabilities[]> {
    const rows = await withDb((db) =>
      db.computeTargetCapabilities.findMany({
        where: { organizationId, projectId },
        orderBy: { uploadedAt: "desc" },
        include: WITH_RUNNER,
      })
    );
    return rows.map(toCapabilities);
  },
};

export async function resolveOrgProjectId(
  project: string,
  organizationId: string
): Promise<string | null> {
  const projectId = await resolveProjectId(project, organizationId);
  if (!projectId) {
    return null;
  }
  // resolveProjectId returns an id as given; the organization owns it only if
  // the row says so.
  const row = await withDb((db) =>
    db.project.findFirst({
      where: { id: projectId, organizationId },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

function toCapabilities(row: CapabilitiesRow): ComputeTargetCapabilities {
  const capabilities = runnerCapabilitiesSchema.safeParse(row.capabilities);
  return {
    id: row.id,
    computeTargetId: row.computeTargetId,
    runnerName: row.computeTarget.machineName,
    isOnline: row.computeTarget.isOnline,
    projectId: row.projectId,
    source: sourceSchema.parse(row.source),
    content: row.content,
    capabilities: capabilities.success ? capabilities.data : null,
    problems: stringListSchema.catch([]).parse(row.problems),
    warnings: stringListSchema.catch([]).parse(row.warnings),
    contentHash: row.contentHash,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}
