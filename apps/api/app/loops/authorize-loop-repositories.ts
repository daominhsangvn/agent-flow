import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  findDocumentRepositoryCheckouts,
  findRepositoryCheckout,
} from "@/app/projects/project-repository-checkouts";
import { authorizeAdditionalRepos } from "./authorize-additional-repos";
import { RepoNotInProjectPoolError } from "./loop-errors";

export type AuthorizeLoopRepositoriesArgs = {
  organizationId: string;
  documentId: string | null | undefined;
  primary: { fullName: string } | undefined;
  additionalRepos: Array<{ fullName: string; branch: string }> | undefined;
  /**
   * Whether the GitHub App path also checks the project's team pool. Off when
   * resuming a loop, whose repositories were checked when it was created.
   */
  checkTeamPool: boolean;
};

/**
 * The repositories a loop may work in.
 *
 * A project with project repositories (integration connections) allows exactly
 * those: every repository on the loop must be one of them, and no GitHub App
 * installation is involved. Without them the GitHub App rules apply: the
 * additional repositories must be in the organization's installation, and
 * every repository in the project's team pool (`assertReposInProjectPool`).
 * Throws `UnauthorizedRepoError` / `RepoNotInProjectPoolError`.
 */
export async function authorizeLoopRepositories(
  args: AuthorizeLoopRepositoriesArgs
): Promise<void> {
  if (loopRepositoryNames(args).length === 0) {
    return;
  }
  const project = await findDocumentRepositoryCheckouts(
    args.organizationId,
    args.documentId
  );
  if (project && project.checkouts.length > 0) {
    const { projectId, checkouts } = project;
    const outside = loopRepositoryNames(args).filter(
      (fullName) => !findRepositoryCheckout(checkouts, fullName)
    );
    if (outside.length > 0) {
      log.warn("authorizeLoopRepositories: not project repositories", {
        organizationId: args.organizationId,
        documentId: args.documentId,
        projectId,
        outside,
      });
      throw new RepoNotInProjectPoolError(projectId, outside);
    }
    return;
  }

  if (args.additionalRepos && args.additionalRepos.length > 0) {
    await authorizeAdditionalRepos(args.additionalRepos, args.organizationId);
  }
  if (args.checkTeamPool) {
    await assertReposInProjectPool({
      organizationId: args.organizationId,
      documentId: args.documentId ?? undefined,
      primary: args.primary,
      additionalRepos: args.additionalRepos,
    });
  }
}

function loopRepositoryNames(args: AuthorizeLoopRepositoriesArgs): string[] {
  return [
    ...(args.primary?.fullName ? [args.primary.fullName] : []),
    ...(args.additionalRepos ?? []).map((repo) => repo.fullName),
  ];
}

type AssertReposInProjectPoolArgs = {
  organizationId: string;
  documentId: string | undefined;
  primary: { fullName: string } | undefined;
  additionalRepos: Array<{ fullName: string }> | undefined;
};

/**
 * Defense-in-depth project-pool membership check (PLN-529 T-4.1).
 *
 * When the loop is associated with a project (via the request's documentId),
 * every repo on the request — primary + additional — must resolve to a
 * `GitHubInstallationRepository` curated on at least one team belonging to
 * that project. Throws `RepoNotInProjectPoolError` otherwise.
 *
 * No-ops when:
 *  - There is no documentId (not project-scoped)
 *  - The artifact has no projectId
 *  - The project has zero team-curated repos (legacy projects pre-PLN-462)
 *
 * The UI gates submission to the team pool, so this firing in production
 * indicates a programmatic client (MCP, CLI, scripts) bypassed the picker.
 */
async function assertReposInProjectPool({
  organizationId,
  documentId,
  primary,
  additionalRepos,
}: AssertReposInProjectPoolArgs): Promise<void> {
  const fullNames: string[] = [];
  if (primary?.fullName) {
    fullNames.push(primary.fullName);
  }
  if (additionalRepos) {
    for (const repo of additionalRepos) {
      fullNames.push(repo.fullName);
    }
  }
  if (!(documentId && fullNames.length > 0)) {
    return;
  }

  const projectInfo = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: documentId, organizationId },
      select: { projectId: true },
    })
  );
  const projectId = projectInfo?.projectId;
  if (!projectId) {
    return;
  }

  const teamRepos = await withDb((db) =>
    db.teamRepository.findMany({
      where: {
        team: {
          projects: { some: { projectId } },
          organizationId,
        },
      },
      select: {
        repository: { select: { fullName: true } },
      },
    })
  );
  if (teamRepos.length === 0) {
    // Legacy projects without a curated pool — fall through to other auth
    // checks (`authorizeAdditionalRepos` already covers org-level access).
    return;
  }

  const poolNames = new Set(teamRepos.map((r) => r.repository.fullName));
  const outsidePool = fullNames.filter((n) => !poolNames.has(n));
  if (outsidePool.length === 0) {
    return;
  }

  log.warn("assertReposInProjectPool: repos outside project pool", {
    organizationId,
    documentId,
    projectId,
    outsidePool,
  });
  throw new RepoNotInProjectPoolError(projectId, outsidePool);
}
