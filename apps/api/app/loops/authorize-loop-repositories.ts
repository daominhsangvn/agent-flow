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
};

/**
 * The repositories a loop may work in.
 *
 * A project with project repositories (integration connections) allows exactly
 * those: every repository on the loop must be one of them, and no GitHub App
 * installation is involved. Without them the primary and additional
 * repositories are checked against the organization's GitHub App installation.
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

  const toVerify = installationCheckRepos(args);
  if (toVerify.length > 0) {
    await authorizeAdditionalRepos(toVerify, args.organizationId);
  }
}

/**
 * The primary repository (when set) and the additional repositories, for the
 * org-installation check. The primary carries an empty branch, so only its
 * installation access is checked, not branch existence.
 */
function installationCheckRepos(
  args: AuthorizeLoopRepositoriesArgs
): Array<{ fullName: string; branch: string }> {
  const additional = args.additionalRepos ?? [];
  const primaryName = args.primary?.fullName;
  if (
    !primaryName ||
    additional.some((repo) => repo.fullName === primaryName)
  ) {
    return additional;
  }
  return [{ fullName: primaryName, branch: "" }, ...additional];
}

function loopRepositoryNames(args: AuthorizeLoopRepositoriesArgs): string[] {
  return [
    ...(args.primary?.fullName ? [args.primary.fullName] : []),
    ...(args.additionalRepos ?? []).map((repo) => repo.fullName),
  ];
}
