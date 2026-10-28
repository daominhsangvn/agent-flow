import { listProjectRepositoryCheckouts } from "./project-repository-checkouts";

/**
 * Resolves a project's repositories for run-loop style callers and manual PR
 * linking. Project repositories (integration connections, `ProjectRepository`)
 * replaced the former GitHub App team pool: the primary is the checkout flagged
 * `isPrimary` (otherwise the oldest), and the list is already primary-first.
 */

export type ResolvedProjectRepo = {
  projectRepositoryId: string;
  fullName: string;
};

export type ResolvedProjectRepoDefaults = {
  primary: ResolvedProjectRepo;
  additional: ResolvedProjectRepo[];
};

export type ResolvedProjectPrLinkRepo = ResolvedProjectRepo & {
  role: "primary" | "additional";
};

/**
 * Returns the project's primary repository plus the additional ones, or null
 * when the project has no connection-backed repositories.
 */
export async function loadProjectRepoDefaults(input: {
  projectId: string;
  organizationId: string;
}): Promise<ResolvedProjectRepoDefaults | null> {
  const repos = await loadProjectRepos(input);
  const [primary, ...additional] = repos;
  if (!primary) {
    return null;
  }
  return { primary, additional };
}

/**
 * Resolve the repository allowlist for manually linking an existing PR: every
 * project repository, primary first, deduped case-insensitively by full name.
 */
export async function loadProjectPrLinkRepositories(input: {
  projectId: string;
  organizationId: string;
}): Promise<ResolvedProjectPrLinkRepo[]> {
  const repos = await loadProjectRepos(input);
  const seen = new Set<string>();
  const deduped: ResolvedProjectPrLinkRepo[] = [];
  for (const repo of repos) {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...repo,
      role: deduped.length === 0 ? "primary" : "additional",
    });
  }
  return deduped;
}

async function loadProjectRepos(input: {
  projectId: string;
  organizationId: string;
}): Promise<ResolvedProjectRepo[]> {
  const checkouts = await listProjectRepositoryCheckouts(
    input.organizationId,
    input.projectId
  );
  return checkouts.map((checkout) => ({
    projectRepositoryId: checkout.id,
    fullName: checkout.fullName,
  }));
}
