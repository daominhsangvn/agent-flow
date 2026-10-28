/**
 * Unit tests for the project repository resolver: project repositories
 * (integration connections) replace the GitHub App team pool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listProjectRepositoryCheckouts } = vi.hoisted(() => ({
  listProjectRepositoryCheckouts: vi.fn(),
}));

vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts,
}));

import {
  loadProjectPrLinkRepositories,
  loadProjectRepoDefaults,
} from "@/app/projects/repository-resolver";

const INPUT = { projectId: "project-1", organizationId: "org-1" };

function checkout(id: string, fullName: string) {
  return { id, fullName };
}

describe("loadProjectRepoDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the project has no repositories", async () => {
    listProjectRepositoryCheckouts.mockResolvedValueOnce([]);

    await expect(loadProjectRepoDefaults(INPUT)).resolves.toBeNull();
    expect(listProjectRepositoryCheckouts).toHaveBeenCalledWith(
      "org-1",
      "project-1"
    );
  });

  it("uses the first repository as primary and the rest as additional", async () => {
    listProjectRepositoryCheckouts.mockResolvedValueOnce([
      checkout("pr-a", "acme/a"),
      checkout("pr-b", "acme/b"),
    ]);

    await expect(loadProjectRepoDefaults(INPUT)).resolves.toEqual({
      primary: { projectRepositoryId: "pr-a", fullName: "acme/a" },
      additional: [{ projectRepositoryId: "pr-b", fullName: "acme/b" }],
    });
  });
});

describe("loadProjectPrLinkRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when the project has no repositories", async () => {
    listProjectRepositoryCheckouts.mockResolvedValueOnce([]);

    await expect(loadProjectPrLinkRepositories(INPUT)).resolves.toEqual([]);
  });

  it("marks the first repository primary and the others additional", async () => {
    listProjectRepositoryCheckouts.mockResolvedValueOnce([
      checkout("pr-a", "acme/a"),
      checkout("pr-b", "acme/b"),
    ]);

    const repos = await loadProjectPrLinkRepositories(INPUT);

    expect(repos.map((r) => [r.fullName, r.role])).toEqual([
      ["acme/a", "primary"],
      ["acme/b", "additional"],
    ]);
  });

  it("dedupes repositories case-insensitively by full name", async () => {
    listProjectRepositoryCheckouts.mockResolvedValueOnce([
      checkout("pr-a", "Acme/A"),
      checkout("pr-b", "acme/a"),
      checkout("pr-c", "acme/c"),
    ]);

    const repos = await loadProjectPrLinkRepositories(INPUT);

    expect(repos.map((r) => r.projectRepositoryId)).toEqual(["pr-a", "pr-c"]);
  });
});
