import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  RepoSource,
  useResolvedJobRepos,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hook collaborators are stubbed at module load. Each test reconfigures the
// stubs to drive a specific resolution-chain branch.
const mockUseProjectRepositories = vi.fn();
const mockUseGitHubRepositories = vi.fn();
const mockUseInheritedAdditionalRepos = vi.fn();

vi.mock("@repo/app/projects/hooks/use-project-repositories", () => ({
  useProjectRepositories: (...args: unknown[]) =>
    mockUseProjectRepositories(...args),
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubRepositories: (...args: unknown[]) =>
    mockUseGitHubRepositories(...args),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useInheritedAdditionalRepos: (...args: unknown[]) =>
    mockUseInheritedAdditionalRepos(...args),
}));

type Repo = {
  id: string;
  fullName: string;
  isPrimary?: boolean;
  connectionId?: string | null;
  provider?: string;
  defaultBranch?: string | null;
};

type Setup = {
  repositories?: Repo[];
  repositoriesError?: boolean;
  githubRepos?: Array<{ id: string; fullName: string }>;
  inherited?: { additionalRepos: Array<{ fullName: string; branch: string }> };
};

function makeRepo(r: Repo) {
  return {
    id: r.id,
    projectId: "p1",
    connectionId: r.connectionId === undefined ? "conn-1" : r.connectionId,
    connectionName: "Conn",
    provider: r.provider ?? IntegrationProviderKey.GitHub,
    externalId: r.id,
    fullName: r.fullName,
    name: r.fullName.split("/")[1] ?? "",
    defaultBranch: r.defaultBranch ?? null,
    webUrl: "",
    isPrimary: r.isPrimary ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function configure(setup: Setup) {
  mockUseProjectRepositories.mockReturnValue({
    data: (setup.repositories ?? []).map(makeRepo),
    isLoading: false,
    isError: setup.repositoriesError ?? false,
  });
  mockUseGitHubRepositories.mockReturnValue({
    data: setup.githubRepos ?? [],
    isLoading: false,
  });
  mockUseInheritedAdditionalRepos.mockReturnValue({
    data: setup.inherited
      ? {
          additionalRepos: setup.inherited.additionalRepos,
          source: { loopId: "loop-1", command: LoopCommand.Plan },
        }
      : { additionalRepos: [], source: null },
    isLoading: false,
  });
}

describe("useResolvedJobRepos", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ISS-5095. Consumers key their empty-vs-failed branch off this field.
  it("propagates a failed repositories read so consumers can tell it apart from an empty pool", () => {
    configure({ repositoriesError: true });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.poolError).toEqual(expect.any(String));
    expect(result.current.pool).toEqual([]);
  });

  it("reports no pool error when the reads succeeded", () => {
    configure({});
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.poolError).toBeNull();
    expect(result.current.primary).toBeNull();
    expect(result.current.additional).toEqual([]);
  });

  it("takes the primary from the repository flagged isPrimary", () => {
    configure({
      repositories: [
        { id: "pr-1", fullName: "org/r1" },
        { id: "pr-2", fullName: "org/r2", isPrimary: true },
      ],
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.primary).toEqual(
      expect.objectContaining({
        id: "pr-2",
        fullName: "org/r2",
        source: RepoSource.ProjectDefault,
        inPool: true,
      })
    );
    expect(result.current.additional).toEqual([]);
  });

  it("excludes repositories without a connection from the pool", () => {
    configure({
      repositories: [
        { id: "pr-1", fullName: "org/r1", isPrimary: true, connectionId: null },
        { id: "pr-2", fullName: "org/r2" },
      ],
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.pool.map((r) => r.id)).toEqual(["pr-2"]);
    expect(result.current.primary).toBeNull();
  });

  it("maps a GitHub repository to its installation repo by case-insensitive name", () => {
    configure({
      repositories: [{ id: "pr-1", fullName: "Org/R1", isPrimary: true }],
      githubRepos: [{ id: "gh-1", fullName: "org/r1" }],
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.pool[0]?.githubRepositoryId).toBe("gh-1");
  });

  it("gives a non-GitHub repository no GitHub id and keeps its default branch", () => {
    configure({
      repositories: [
        {
          id: "pr-1",
          fullName: "org/proj/r1",
          isPrimary: true,
          provider: IntegrationProviderKey.AzureDevOps,
          defaultBranch: "develop",
        },
      ],
      githubRepos: [{ id: "gh-1", fullName: "org/proj/r1" }],
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.pool[0]).toEqual(
      expect.objectContaining({
        githubRepositoryId: null,
        defaultBranch: "develop",
      })
    );
  });

  it("labels a primary seed found in the pool as prior-loop when a prior loop exists", () => {
    configure({
      repositories: [
        { id: "pr-1", fullName: "org/r1", isPrimary: true },
        { id: "pr-2", fullName: "org/r2" },
      ],
      inherited: { additionalRepos: [] },
    });
    mockUseInheritedAdditionalRepos.mockReturnValue({
      data: {
        additionalRepos: [],
        source: { loopId: "loop-1", command: LoopCommand.Plan },
      },
      isLoading: false,
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({
        projectId: "p1",
        artifactId: "doc-1",
        command: LoopCommand.Plan,
        primaryFullNameSeed: "org/r2",
      })
    );
    expect(result.current.primary).toEqual(
      expect.objectContaining({ id: "pr-2", source: RepoSource.PriorLoop })
    );
  });

  it("uses the inherited prior-loop peers as additional with prior-loop label", () => {
    configure({
      repositories: [
        { id: "pr-1", fullName: "org/r1", isPrimary: true },
        { id: "pr-2", fullName: "org/r2" },
      ],
      inherited: {
        additionalRepos: [{ fullName: "org/r2", branch: "feature/x" }],
      },
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({
        projectId: "p1",
        artifactId: "doc-1",
        command: LoopCommand.Execute,
      })
    );
    expect(result.current.additional).toEqual([
      expect.objectContaining({
        id: "pr-2",
        fullName: "org/r2",
        source: RepoSource.PriorLoop,
        // Prior-loop peer branches are preserved so the follow-up run keeps
        // the branch the prior loop used.
        branch: "feature/x",
      }),
    ]);
  });
});
