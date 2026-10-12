import type {
  AdditionalRepoRef,
  AdditionalRepoRefWithToken,
} from "@repo/api/src/types/loop";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import {
  findDocumentRepositoryCheckouts,
  findRepositoryCheckout,
} from "@/app/projects/project-repository-checkouts";

/**
 * The repositories a launched loop receives.
 *
 * A loop on a project's project repositories (repositories from integration
 * connections) gets each one's `cloneUrl` and the project's agent
 * instructions. The computer builds a workspace folder with every repository
 * as a subdirectory and the instructions as its root `CLAUDE.md`, runs the
 * agent from that folder, and clones/pushes over HTTPS with credentials from
 * `POST /loops/:id/git-credential`, so no repository token leaves the API.
 * The loop's `repo` is only the first repository (where its branch is
 * recorded); all repositories are equal to the agent. Such a loop uses the
 * computer's own branch naming (no branch materialization, which verifies
 * GitHub `owner/repo` origins), and EXECUTE only pushes: a workflow action
 * opens the pull requests.
 */

type LaunchLoop = {
  repo: { fullName: string; branch: string } | null;
  additionalRepos: AdditionalRepoRef[] | null;
  documentId: string | null;
};

export type LaunchRepositories = {
  /** The first repository with its cloneUrl; undefined when it has none. */
  repoInfo: { fullName: string; branch: string; cloneUrl: string } | undefined;
  additionalRepos: AdditionalRepoRefWithToken[] | undefined;
  /** Whether the loop works on project repositories. */
  projectRepositories: boolean;
  /** The project's agent instructions, for a loop on project repositories. */
  projectInstructions: string | undefined;
};

export async function resolveLaunchRepositories(input: {
  loop: LaunchLoop;
  organizationId: string;
  isDesktop: boolean;
  resolveGitHubToken: (
    organizationId: string,
    fullName: string
  ) => Promise<string>;
}): Promise<LaunchRepositories> {
  const { loop, organizationId, isDesktop } = input;
  const additionalRepos = await resolveAdditionalRepos(
    loop.additionalRepos,
    organizationId,
    isDesktop,
    input.resolveGitHubToken
  );
  const project =
    isDesktop && loop.repo
      ? await findDocumentRepositoryCheckouts(organizationId, loop.documentId)
      : null;
  const checkouts = project?.checkouts ?? [];
  const primary = findRepositoryCheckout(checkouts, loop.repo?.fullName);
  if (!(primary && loop.repo)) {
    return {
      repoInfo: undefined,
      additionalRepos,
      projectRepositories: false,
      projectInstructions: undefined,
    };
  }
  return {
    repoInfo: { ...loop.repo, cloneUrl: primary.cloneUrl },
    additionalRepos: additionalRepos?.map((repo) => {
      const checkout = findRepositoryCheckout(checkouts, repo.fullName);
      return checkout ? { ...repo, cloneUrl: checkout.cloneUrl } : repo;
    }),
    projectRepositories: true,
    projectInstructions: project?.instructions || undefined,
  };
}

/**
 * Cap and resolve GitHub tokens for additional repos declared on the loop.
 *
 * - Enforces MAX_ADDITIONAL_REPOS defensively via slice.
 * - Cloud/ECS: resolves a GitHub App installation token per repo (fail-fast).
 * - Desktop: includes repo entries without tokens — the electron has its own
 *   GitHub auth (gh CLI) locally, or clones project repositories by URL.
 * - User-level auth is deferred to the runner; only installation-level tokens
 *   are resolved here.
 */
async function resolveAdditionalRepos(
  additionalRepos: AdditionalRepoRef[] | null,
  organizationId: string,
  isDesktop: boolean,
  resolveGitHubToken: (
    organizationId: string,
    fullName: string
  ) => Promise<string>
): Promise<AdditionalRepoRefWithToken[] | undefined> {
  // Defensive: enforce MAX_ADDITIONAL_REPOS cap regardless of how the list
  // entered the system.
  const cappedAdditionalRepos = (additionalRepos ?? []).slice(
    0,
    MAX_ADDITIONAL_REPOS
  );

  if (cappedAdditionalRepos.length === 0) {
    return undefined;
  }

  if (isDesktop) {
    return cappedAdditionalRepos.map((r) => ({
      fullName: r.fullName,
      branch: r.branch,
    }));
  }

  // Cloud/ECS: resolve a GitHub installation token per repo. Each resolution is
  // two sequential network round-trips (a DB installation lookup + a GitHub
  // installation-token API call), so resolve all repos concurrently rather than
  // serially — N is bounded by MAX_ADDITIONAL_REPOS but the serial latency would
  // otherwise be N×(DB+API). Promise.all preserves both input order (via map)
  // and fail-fast: if any token cannot be resolved it rejects immediately so the
  // loop fails before ECS dispatch rather than failing inside the container with
  // a cryptic auth error.
  return await Promise.all(
    cappedAdditionalRepos.map(async (repoRef) => ({
      fullName: repoRef.fullName,
      branch: repoRef.branch,
      githubToken: await resolveGitHubToken(organizationId, repoRef.fullName),
    }))
  );
}
