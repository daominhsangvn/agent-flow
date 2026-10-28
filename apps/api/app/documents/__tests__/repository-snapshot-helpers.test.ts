import {
  type ArtifactRepositorySnapshot,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSnapshotFromLoopSelection,
  buildSnapshotFromProjectDefaults,
  inheritSnapshotFromParent,
  parseStoredSnapshot,
} from "@/app/documents/repository-snapshot-helpers";
import { listProjectRepositoryCheckouts } from "@/app/projects/project-repository-checkouts";

// Project repositories are the only source of project defaults.
vi.mock("@/app/projects/project-repository-checkouts", async (original) => ({
  ...(await original<
    typeof import("@/app/projects/project-repository-checkouts")
  >()),
  listProjectRepositoryCheckouts: vi.fn(() => Promise.resolve([])),
}));

describe("buildSnapshotFromLoopSelection", () => {
  it("marks the primary repo as role=primary at position 0", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api", branch: "main" },
    });

    expect(snapshot.source).toBe(SnapshotSource.LoopSelection);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      fullName: "acme/api",
      role: RepositoryRole.Primary,
      position: 0,
      branch: "main",
    });
  });

  it("orders additional repos starting at position 1 in input order", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api" },
      additional: [
        { fullName: "acme/web", branch: "develop" },
        { fullName: "acme/shared" },
      ],
    });

    expect(snapshot.repositories).toHaveLength(3);
    expect(snapshot.repositories[1]).toMatchObject({
      fullName: "acme/web",
      role: RepositoryRole.Additional,
      position: 1,
      branch: "develop",
    });
    expect(snapshot.repositories[2]).toMatchObject({
      fullName: "acme/shared",
      role: RepositoryRole.Additional,
      position: 2,
    });
    expect(snapshot.repositories[2]).not.toHaveProperty("branch");
  });

  it("omits the branch field entirely when not supplied", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api" },
    });
    expect(snapshot.repositories[0]).not.toHaveProperty("branch");
  });

  it("treats a null branch as absent", () => {
    const snapshot = buildSnapshotFromLoopSelection({
      primary: { fullName: "acme/api", branch: null },
    });
    expect(snapshot.repositories[0]).not.toHaveProperty("branch");
  });
});

describe("inheritSnapshotFromParent", () => {
  it("preserves repositories and rewrites source to parent_artifact", () => {
    const parent: ArtifactRepositorySnapshot = {
      repositories: [
        {
          fullName: "acme/api",
          role: RepositoryRole.Primary,
          position: 0,
          branch: "main",
        },
        {
          fullName: "acme/web",
          role: RepositoryRole.Additional,
          position: 1,
        },
      ],
      source: SnapshotSource.LoopSelection,
    };

    const inherited = inheritSnapshotFromParent(parent);

    expect(inherited.source).toBe(SnapshotSource.ParentArtifact);
    expect(inherited.repositories).toEqual(parent.repositories);
  });

  it("retains parent source even if it was already parent_artifact (chain)", () => {
    const parent: ArtifactRepositorySnapshot = {
      repositories: [
        {
          fullName: "acme/api",
          role: RepositoryRole.Primary,
          position: 0,
        },
      ],
      source: SnapshotSource.ParentArtifact,
    };
    const inherited = inheritSnapshotFromParent(parent);
    expect(inherited.source).toBe(SnapshotSource.ParentArtifact);
  });
});

describe("parseStoredSnapshot", () => {
  it("returns the parsed snapshot when shape is valid", () => {
    const stored = {
      repositories: [
        {
          fullName: "acme/api",
          role: "primary",
          position: 0,
        },
      ],
      source: "project_defaults",
    };
    const parsed = parseStoredSnapshot(stored);
    expect(parsed).not.toBeNull();
    expect(parsed?.source).toBe(SnapshotSource.ProjectDefaults);
    expect(parsed?.repositories[0]?.fullName).toBe("acme/api");
  });

  it("returns null for null input", () => {
    expect(parseStoredSnapshot(null)).toBeNull();
  });

  it("returns null when repositories field is missing", () => {
    expect(parseStoredSnapshot({ source: "none" })).toBeNull();
  });

  it("returns null when source is not a valid enum value", () => {
    expect(
      parseStoredSnapshot({ repositories: [], source: "bogus" })
    ).toBeNull();
  });

  it("returns null when a repo entry is missing required fields", () => {
    expect(
      parseStoredSnapshot({
        repositories: [{ role: "primary", position: 0 }],
        source: "none",
      })
    ).toBeNull();
  });

  it("accepts an empty repositories array with source=none", () => {
    const parsed = parseStoredSnapshot({
      repositories: [],
      source: "none",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.repositories).toEqual([]);
    expect(parsed?.source).toBe(SnapshotSource.None);
  });
});

describe("buildSnapshotFromProjectDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty 'none' snapshot when the project has no repositories", async () => {
    vi.mocked(listProjectRepositoryCheckouts).mockResolvedValue([]);

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1"
    );

    expect(snapshot.source).toBe(SnapshotSource.None);
    expect(snapshot.repositories).toEqual([]);
  });

  it("puts the primary at position 0 and the rest as additional", async () => {
    vi.mocked(listProjectRepositoryCheckouts).mockResolvedValue([
      { fullName: "acme/web" },
      { fullName: "acme/api" },
    ] as Awaited<ReturnType<typeof listProjectRepositoryCheckouts>>);

    const snapshot = await buildSnapshotFromProjectDefaults(
      "project-1",
      "org-1"
    );

    expect(snapshot.source).toBe(SnapshotSource.ProjectDefaults);
    expect(snapshot.repositories).toEqual([
      { fullName: "acme/web", role: RepositoryRole.Primary, position: 0 },
      { fullName: "acme/api", role: RepositoryRole.Additional, position: 1 },
    ]);
  });
});
