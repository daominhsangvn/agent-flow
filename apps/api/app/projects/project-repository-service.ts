import {
  type AddProjectRepositoryInput,
  PROJECT_REPOSITORIES_MAX,
  type ProjectRepository,
} from "@repo/api/src/types/project-repository";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  getConnectionRepository,
  loadRepositoryConnection,
} from "@/lib/integrations/repositories";
import type { RepositoryInfo } from "@/lib/integrations/types";

/**
 * Repositories of a project (Project settings → Repositories). Each one is
 * taken from an integration connection with the repositories capability; the
 * connection keeps the credentials, this table only records which repository
 * the project works on. Exactly one repository per project is primary.
 *
 * Writes take a per-project advisory lock so the primary flag and the
 * repository limit hold under concurrent requests.
 */

export type ProjectRepositoryServiceError = {
  status: StatusCode;
  message: string;
};

type ServiceResult<T> = Result<T, ProjectRepositoryServiceError>;

const REPOSITORY_INCLUDE = {
  connection: { select: { name: true } },
} as const satisfies Prisma.ProjectRepositoryInclude;

type ProjectRepositoryRecord = Prisma.ProjectRepositoryGetPayload<{
  include: typeof REPOSITORY_INCLUDE;
}>;

const REPOSITORY_ORDER = [
  { isPrimary: "desc" },
  { createdAt: "asc" },
] as const satisfies Prisma.ProjectRepositoryOrderByWithRelationInput[];

export const projectRepositoryService = {
  /** Null when the project does not exist in the organization. */
  async list(
    organizationId: string,
    projectId: string
  ): Promise<ProjectRepository[] | null> {
    if (!(await projectExists(organizationId, projectId))) {
      return null;
    }
    const records = await withDb((db) =>
      db.projectRepository.findMany({
        where: { organizationId, projectId },
        include: REPOSITORY_INCLUDE,
        orderBy: [...REPOSITORY_ORDER],
      })
    );
    return records.map(toProjectRepository);
  },

  /**
   * Adds a repository the connection can access. The first repository of a
   * project, or one added with `isPrimary`, becomes the primary repository.
   */
  async add(
    organizationId: string,
    projectId: string,
    userId: string,
    input: AddProjectRepositoryInput
  ): Promise<ServiceResult<ProjectRepository>> {
    if (!(await projectExists(organizationId, projectId))) {
      return serviceError(Status.NotFound, "Project not found");
    }
    const connection = await loadRepositoryConnection(
      organizationId,
      input.connectionId
    );
    if (!connection.ok) {
      return connection;
    }
    const repository = await getConnectionRepository(
      connection.value,
      input.externalId
    );
    if (!repository.ok) {
      return repository;
    }
    return insertRepository({
      organizationId,
      projectId,
      userId,
      connectionId: connection.value.loaded.record.id,
      provider: connection.value.loaded.record.provider,
      repository: repository.value,
      isPrimary: input.isPrimary === true,
    });
  },

  /** Makes the repository the project's primary repository. */
  setPrimary(
    organizationId: string,
    projectId: string,
    repositoryId: string
  ): Promise<ServiceResult<ProjectRepository>> {
    return withDb.tx(async (tx) => {
      await lockProjectRepositories(tx, projectId);
      const existing = await tx.projectRepository.findFirst({
        where: { id: repositoryId, organizationId, projectId },
        select: { id: true },
      });
      if (!existing) {
        return serviceError(Status.NotFound, "Project repository not found");
      }
      await tx.projectRepository.updateMany({
        where: { projectId, isPrimary: true, id: { not: repositoryId } },
        data: { isPrimary: false },
      });
      const updated = await tx.projectRepository.update({
        where: { id: repositoryId },
        data: { isPrimary: true },
        include: REPOSITORY_INCLUDE,
      });
      return Result.ok(toProjectRepository(updated));
    });
  },

  /**
   * Removes the repository from the project. When it was primary, the oldest
   * remaining repository becomes primary.
   */
  remove(
    organizationId: string,
    projectId: string,
    repositoryId: string
  ): Promise<ServiceResult<{ deleted: true }>> {
    return withDb.tx(async (tx) => {
      await lockProjectRepositories(tx, projectId);
      const existing = await tx.projectRepository.findFirst({
        where: { id: repositoryId, organizationId, projectId },
        select: { id: true, isPrimary: true },
      });
      if (!existing) {
        return serviceError(Status.NotFound, "Project repository not found");
      }
      await tx.projectRepository.delete({ where: { id: repositoryId } });
      if (existing.isPrimary) {
        await promoteOldestRepository(tx, projectId);
      }
      return Result.ok({ deleted: true as const });
    });
  },
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

type InsertRepositoryInput = {
  organizationId: string;
  projectId: string;
  userId: string;
  connectionId: string;
  provider: string;
  repository: RepositoryInfo;
  isPrimary: boolean;
};

function insertRepository(
  input: InsertRepositoryInput
): Promise<ServiceResult<ProjectRepository>> {
  const { organizationId, projectId, repository } = input;
  return withDb.tx(async (tx) => {
    await lockProjectRepositories(tx, projectId);
    const existing = await tx.projectRepository.findMany({
      where: { projectId },
      select: { provider: true, externalId: true },
    });
    const duplicate = existing.some(
      (row) =>
        row.provider === input.provider &&
        row.externalId === repository.externalId
    );
    if (duplicate) {
      return serviceError(
        Status.Conflict,
        `${repository.fullName} is already a repository of this project`
      );
    }
    if (existing.length >= PROJECT_REPOSITORIES_MAX) {
      return serviceError(
        Status.Conflict,
        `A project can have at most ${PROJECT_REPOSITORIES_MAX} repositories`
      );
    }
    const isPrimary = input.isPrimary || existing.length === 0;
    if (isPrimary) {
      await tx.projectRepository.updateMany({
        where: { projectId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    const created = await tx.projectRepository.create({
      data: {
        organizationId,
        projectId,
        connectionId: input.connectionId,
        provider: input.provider,
        externalId: repository.externalId,
        fullName: repository.fullName,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        webUrl: repository.webUrl,
        cloneUrl: repository.cloneUrl,
        isPrimary,
        createdById: input.userId,
      },
      include: REPOSITORY_INCLUDE,
    });
    return Result.ok(toProjectRepository(created));
  });
}

async function promoteOldestRepository(
  tx: TransactionClient,
  projectId: string
): Promise<void> {
  const next = await tx.projectRepository.findFirst({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (next) {
    await tx.projectRepository.update({
      where: { id: next.id },
      data: { isPrimary: true },
    });
  }
}

async function lockProjectRepositories(
  tx: TransactionClient,
  projectId: string
): Promise<void> {
  const lockKey = `project-repositories:${projectId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
}

function toProjectRepository(
  record: ProjectRepositoryRecord
): ProjectRepository {
  return {
    id: record.id,
    projectId: record.projectId,
    connectionId: record.connectionId,
    connectionName: record.connection?.name ?? null,
    provider: record.provider,
    externalId: record.externalId,
    fullName: record.fullName,
    name: record.name,
    defaultBranch: record.defaultBranch,
    webUrl: record.webUrl,
    isPrimary: record.isPrimary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serviceError<T>(
  status: StatusCode,
  message: string
): ServiceResult<T> {
  return Result.err({ status, message });
}
