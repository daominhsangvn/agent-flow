import {
  PROCESS_VERSIONS_LIST_MAX,
  type ProjectProcess,
  type ProjectProcessState,
  type ProjectProcessVersion,
  type ProjectProcessVersions,
  projectProcessSchema,
  type RunProcessSnapshot,
  RunProcessSource,
  type UpdateProjectProcessInput,
} from "@repo/api/src/types/project-process";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  findRepositoryCheckout,
  listProjectRepositoryCheckouts,
} from "./project-repository-checkouts";

/**
 * The process of a project (project_process_versions): the steps its workflow
 * runs follow between pre and post actions. Versions are append-only; the
 * highest one is current. A project without a version, or whose latest
 * version is a reset (definition JSON null), runs the built-in AgentFlow
 * flow (derived from each workflow's agent config).
 */

export const CurrentProcessKind = {
  /** No version, or reset: the built-in AgentFlow flow. */
  None: "none",
  Found: "found",
  /** The stored definition does not parse (e.g. written by a newer build). */
  Invalid: "invalid",
} as const;

export type CurrentProcess =
  | { kind: typeof CurrentProcessKind.None }
  | { kind: typeof CurrentProcessKind.Found; snapshot: RunProcessSnapshot }
  | { kind: typeof CurrentProcessKind.Invalid; version: number };

export type ProjectProcessServiceError = {
  status: StatusCode;
  message: string;
};

/** Unique (project, version): a concurrent save took the number first. */
const UNIQUE_VIOLATION = "P2002";
const SAVE_ATTEMPTS = 3;

const VERSION_SELECT = {
  version: true,
  definition: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

export const projectProcessService = {
  async findCurrent(
    organizationId: string,
    projectId: string
  ): Promise<CurrentProcess> {
    const row = await withDb((db) =>
      db.projectProcessVersion.findFirst({
        where: { organizationId, projectId },
        orderBy: { version: "desc" },
        select: { version: true, definition: true },
      })
    );
    if (!row || row.definition === null) {
      return { kind: CurrentProcessKind.None };
    }
    const definition = projectProcessSchema.safeParse(row.definition);
    return definition.success
      ? {
          kind: CurrentProcessKind.Found,
          snapshot: {
            version: row.version,
            source: RunProcessSource.Project,
            definition: definition.data,
          },
        }
      : { kind: CurrentProcessKind.Invalid, version: row.version };
  },

  /** Null when the project does not exist in the organization. */
  async get(
    organizationId: string,
    projectId: string
  ): Promise<ProjectProcessState | null> {
    if (!(await projectExists(organizationId, projectId))) {
      return null;
    }
    const row = await withDb((db) =>
      db.projectProcessVersion.findFirst({
        where: { organizationId, projectId },
        orderBy: { version: "desc" },
        select: VERSION_SELECT,
      })
    );
    return toState(row);
  },

  /** Newest first; null when the project does not exist in the organization. */
  async listVersions(
    organizationId: string,
    projectId: string
  ): Promise<ProjectProcessVersions | null> {
    if (!(await projectExists(organizationId, projectId))) {
      return null;
    }
    const rows = await withDb((db) =>
      db.projectProcessVersion.findMany({
        where: { organizationId, projectId },
        orderBy: { version: "desc" },
        take: PROCESS_VERSIONS_LIST_MAX,
        select: VERSION_SELECT,
      })
    );
    return {
      versions: rows.flatMap((row) => {
        const version = toVersion(row);
        return version ? [version] : [];
      }),
    };
  },

  /**
   * Saves a new version (the project's process from now on; runs already
   * started keep their snapshot). `process: null` goes back to the built-in
   * flow. The toolkit must be one of the project's repositories, so its
   * worktree is in each loop's workspace.
   */
  async save(
    organizationId: string,
    userId: string,
    projectId: string,
    input: UpdateProjectProcessInput
  ): Promise<Result<ProjectProcessState, ProjectProcessServiceError>> {
    if (!(await projectExists(organizationId, projectId))) {
      return failure(Status.NotFound, "Project not found");
    }
    const parsed = projectProcessSchema.nullable().safeParse(input.process);
    if (!parsed.success) {
      return failure(
        Status.BadRequest,
        parsed.error.issues[0]?.message ?? "The process is not valid"
      );
    }
    const process = parsed.data;
    const toolkitError = await checkProcessToolkit(
      organizationId,
      projectId,
      process
    );
    if (toolkitError) {
      return failure(Status.BadRequest, toolkitError);
    }
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      try {
        const row = await insertNextVersion(
          organizationId,
          userId,
          projectId,
          process
        );
        return Result.ok(toState(row));
      } catch (error) {
        if (
          getPrismaErrorCode(error) !== UNIQUE_VIOLATION ||
          attempt === SAVE_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    return failure(Status.Conflict, "The process changed; save it again");
  },
};

type VersionRow = {
  version: number;
  definition: unknown;
  createdAt: Date;
  createdBy: {
    id: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
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

async function insertNextVersion(
  organizationId: string,
  userId: string,
  projectId: string,
  process: ProjectProcess | null
): Promise<VersionRow> {
  return await withDb.tx(async (db) => {
    const latest = await db.projectProcessVersion.findFirst({
      where: { organizationId, projectId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return await db.projectProcessVersion.create({
      data: {
        organizationId,
        projectId,
        version: (latest?.version ?? 0) + 1,
        definition: process ?? Prisma.JsonNull,
        createdById: userId,
      },
      select: VERSION_SELECT,
    });
  });
}

/**
 * Null when the process has no toolkit or its toolkit is one of the
 * project's repositories; else the message to show. Workflow saves use it for
 * a workflow's own process too.
 */
export async function checkProcessToolkit(
  organizationId: string,
  projectId: string,
  process: ProjectProcess | null
): Promise<string | null> {
  const toolkit = process?.toolkit;
  if (!toolkit) {
    return null;
  }
  const checkouts = await listProjectRepositoryCheckouts(
    organizationId,
    projectId
  );
  return findRepositoryCheckout(checkouts, toolkit.repository)
    ? null
    : `The toolkit repository ${toolkit.repository} is not one of the project's repositories. Add it on the Repositories tab first.`;
}

function toState(row: VersionRow | null): ProjectProcessState {
  if (!row || row.definition === null) {
    return { current: null, invalidVersion: null };
  }
  const version = toVersion(row);
  return version
    ? { current: version, invalidVersion: null }
    : { current: null, invalidVersion: row.version };
}

/** Null when the stored definition no longer parses. */
function toVersion(row: VersionRow): ProjectProcessVersion | null {
  let definition: ProjectProcess | null = null;
  if (row.definition !== null) {
    const parsed = projectProcessSchema.safeParse(row.definition);
    if (!parsed.success) {
      return null;
    }
    definition = parsed.data;
  }
  const name = [row.createdBy?.firstName, row.createdBy?.lastName]
    .filter(Boolean)
    .join(" ");
  return {
    version: row.version,
    definition,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy
      ? { id: row.createdBy.id, name: name || null }
      : null,
  };
}

function failure(
  status: StatusCode,
  message: string
): Result<never, ProjectProcessServiceError> {
  return Result.err({ status, message });
}
