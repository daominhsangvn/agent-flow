"use client";

import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LoopCommand } from "@repo/api/src/types/loop";
import type { ProjectRepository } from "@repo/api/src/types/project-repository";
import { useGitHubRepositories } from "@repo/app/github/hooks/use-github-integration";
import { useInheritedAdditionalRepos } from "@repo/app/loops/hooks/use-loops";
import { useProjectRepositories } from "@repo/app/projects/hooks/use-project-repositories";
import { useMemo } from "react";

export const RepoSource = {
  PriorLoop: "prior-loop",
  ProjectDefault: "project-default",
  // Repo the user manually included in the picker; not seeded by the
  // resolver. Labeled separately so the row doesn't claim to come from the
  // project's repositories when it doesn't.
  UserAdded: "user-added",
} as const;
export type RepoSource = (typeof RepoSource)[keyof typeof RepoSource];

export type ResolvedRepo = {
  // Pool repos identify by `ProjectRepository.id`. Prior-loop seeds not
  // found in the pool carry their `fullName` here instead; in that case
  // `inPool` is false and the entry is informational only.
  id: string;
  fullName: string;
  source: RepoSource;
  inPool: boolean;
  // Pre-resolved branch — set for prior-loop peers (so the follow-up run keeps
  // the same branch the prior loop used). Unset for pool rows whose branch
  // should fall back to the repository default at submit time.
  branch?: string;
};

export type UseResolvedJobReposResult = {
  primary: ResolvedRepo | null;
  additional: ResolvedRepo[];
  pool: JobRepoPoolEntry[];
  isLoading: boolean;
  // Why the pool is empty, when it is empty because the read FAILED (ISS-5095).
  // Without this the resolver hands consumers an empty `pool` and they render
  // "No repositories on this project" — a claim about the project's
  // configuration that the code has no evidence for. `null` when the reads
  // succeeded, in which case an empty pool really is empty.
  poolError: string | null;
};

export type UseResolvedJobReposArgs = {
  projectId: string | null | undefined;
  // The artifact this job will run against. Used to look up the prior-loop
  // peer set; pass null for "no inheritance".
  artifactId?: string | null;
  // The command about to be launched. Drives prior-loop precedence on the
  // backend (e.g. PLAN inherits from GENERATE_PRD).
  command?: LoopCommand;
  // Optional carry-forward of the artifact's existing `targetRepo`. When the
  // resolver finds it inside the pool it becomes the primary and is labeled
  // `prior-loop` if a prior loop exists, else `project-default`.
  primaryFullNameSeed?: string | null;
  enabled?: boolean;
};

export const PROJECT_REPOSITORIES_LOAD_FAILURE =
  "We couldn't load this project's repositories. Reload the page to try again.";

// Composes the resolution chain (prior loop > project primary repository) plus
// per-repo source labels. The result is the seed state for
// `JobRepositoriesSection`; user edits inside the section override these
// values without writing them back to the project.
export function useResolvedJobRepos({
  projectId,
  artifactId,
  command,
  primaryFullNameSeed,
  enabled = true,
}: UseResolvedJobReposArgs): UseResolvedJobReposResult {
  const repositoriesEnabled = enabled && Boolean(projectId);
  const {
    data: repositories,
    isLoading: isLoadingRepositories,
    isError: repositoriesFailed,
  } = useProjectRepositories(projectId ?? "", {
    enabled: repositoriesEnabled,
  });

  const connected = useMemo(
    () => sortConnectedRepositories(repositories ?? []),
    [repositories]
  );
  const hasGitHubRepo = connected.some(
    (r) => r.provider === IntegrationProviderKey.GitHub
  );
  const githubEnabled = repositoriesEnabled && hasGitHubRepo;
  const { data: githubRepos, isLoading: isLoadingGitHub } =
    useGitHubRepositories({ enabled: githubEnabled });

  const pool = useMemo(
    () => buildPool(connected, githubRepos ?? []),
    [connected, githubRepos]
  );

  const inheritEnabled = enabled && Boolean(artifactId) && Boolean(command);
  const { data: inherited, isLoading: isLoadingInherited } =
    useInheritedAdditionalRepos(
      artifactId ?? null,
      // command is gated by inheritEnabled — when disabled the hook never
      // runs the queryFn so the fallback value is unused.
      command ?? LoopCommand.Plan,
      { enabled: inheritEnabled }
    );

  return useMemo<UseResolvedJobReposResult>(() => {
    const isLoading =
      (repositoriesEnabled && isLoadingRepositories) ||
      (githubEnabled && isLoadingGitHub) ||
      (inheritEnabled && isLoadingInherited);

    const primary = buildPrimary({
      pool,
      primaryFullNameSeed: primaryFullNameSeed ?? null,
      hasPriorLoop: Boolean(inherited?.source),
    });

    const additional = buildAdditional({
      pool,
      priorPeers: inherited?.additionalRepos ?? [],
    });

    return {
      primary,
      additional,
      pool,
      isLoading,
      poolError: repositoriesFailed ? PROJECT_REPOSITORIES_LOAD_FAILURE : null,
    };
  }, [
    pool,
    primaryFullNameSeed,
    inherited,
    inheritEnabled,
    repositoriesEnabled,
    githubEnabled,
    repositoriesFailed,
    isLoadingRepositories,
    isLoadingGitHub,
    isLoadingInherited,
  ]);
}

function sortConnectedRepositories(
  repositories: ProjectRepository[]
): ProjectRepository[] {
  const connected = repositories.filter((r) => r.connectionId !== null);
  return [...connected].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary)
  );
}

function buildPool(
  connected: ProjectRepository[],
  githubRepos: Array<{ id: string; fullName: string }>
): JobRepoPoolEntry[] {
  const githubIdByName = new Map(
    githubRepos.map((r) => [r.fullName.toLowerCase(), r.id])
  );
  return connected.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    provider: r.provider,
    isPrimary: r.isPrimary,
    defaultBranch: r.defaultBranch,
    githubRepositoryId:
      r.provider === IntegrationProviderKey.GitHub
        ? (githubIdByName.get(r.fullName.toLowerCase()) ?? null)
        : null,
  }));
}

type BuildPrimaryArgs = {
  pool: JobRepoPoolEntry[];
  primaryFullNameSeed: string | null;
  hasPriorLoop: boolean;
};

function buildPrimary({
  pool,
  primaryFullNameSeed,
  hasPriorLoop,
}: BuildPrimaryArgs): ResolvedRepo | null {
  if (primaryFullNameSeed) {
    const fromPool = pool.find((r) => r.fullName === primaryFullNameSeed);
    if (fromPool) {
      return toPoolResolved(
        fromPool,
        hasPriorLoop ? RepoSource.PriorLoop : RepoSource.ProjectDefault
      );
    }
    // Seed not in the pool. Keep it only when a prior loop pinned it (so the
    // follow-up run targets the same repo); otherwise drop it and let the
    // project's primary repository decide.
    if (hasPriorLoop) {
      return {
        id: primaryFullNameSeed,
        fullName: primaryFullNameSeed,
        source: RepoSource.PriorLoop,
        inPool: false,
      };
    }
  }

  const primary = pool.find((r) => r.isPrimary);
  return primary ? toPoolResolved(primary, RepoSource.ProjectDefault) : null;
}

type BuildAdditionalArgs = {
  pool: JobRepoPoolEntry[];
  priorPeers: Array<{ fullName: string; branch: string }>;
};

function buildAdditional({
  pool,
  priorPeers,
}: BuildAdditionalArgs): ResolvedRepo[] {
  return priorPeers.map((peer) => {
    const fromPool = pool.find((r) => r.fullName === peer.fullName);
    if (fromPool) {
      return {
        ...toPoolResolved(fromPool, RepoSource.PriorLoop),
        branch: peer.branch,
      };
    }
    return {
      id: peer.fullName,
      fullName: peer.fullName,
      source: RepoSource.PriorLoop,
      inPool: false,
      branch: peer.branch,
    };
  });
}

function toPoolResolved(entry: JobRepoPoolEntry, source: RepoSource) {
  return {
    id: entry.id,
    fullName: entry.fullName,
    source,
    inPool: true,
  };
}

export type JobRepoPoolEntry = {
  id: string;
  fullName: string;
  provider: string;
  isPrimary: boolean;
  defaultBranch: string | null;
  githubRepositoryId: string | null;
};
