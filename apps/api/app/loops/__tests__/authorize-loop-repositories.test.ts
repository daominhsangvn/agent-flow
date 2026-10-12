import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeLoopRepositories } from "@/app/loops/authorize-loop-repositories";
import { RepoNotInProjectPoolError } from "@/app/loops/loop-errors";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const DOCUMENT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000p1";

const mocks = vi.hoisted(() => ({
  projectId: null as string | null,
  checkouts: [] as Array<{ fullName: string }>,
  teamRepos: [] as Array<{ repository: { fullName: string } }>,
  authorizeAdditionalRepos: vi.fn(),
}));

vi.mock("@/app/projects/project-repository-checkouts", async (original) => ({
  ...(await original<
    typeof import("@/app/projects/project-repository-checkouts")
  >()),
  findDocumentRepositoryCheckouts: vi.fn(() =>
    Promise.resolve(
      mocks.projectId
        ? { projectId: mocks.projectId, checkouts: mocks.checkouts }
        : null
    )
  ),
}));
vi.mock("@/app/loops/authorize-additional-repos", () => ({
  authorizeAdditionalRepos: mocks.authorizeAdditionalRepos,
}));
vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      artifact: {
        findFirst: () => Promise.resolve({ projectId: mocks.projectId }),
      },
      teamRepository: { findMany: () => Promise.resolve(mocks.teamRepos) },
    }),
}));

const base = {
  organizationId: ORG_ID,
  documentId: DOCUMENT_ID,
  checkTeamPool: true,
};

beforeEach(() => {
  mocks.projectId = PROJECT_ID;
  mocks.checkouts = [{ fullName: "acme/api" }, { fullName: "acme/web" }];
  mocks.teamRepos = [];
  mocks.authorizeAdditionalRepos.mockReset();
});

describe("authorizeLoopRepositories", () => {
  it("allows the project repositories without a GitHub App check", async () => {
    await authorizeLoopRepositories({
      ...base,
      primary: { fullName: "ACME/api" },
      additionalRepos: [{ fullName: "acme/web", branch: "main" }],
    });

    expect(mocks.authorizeAdditionalRepos).not.toHaveBeenCalled();
  });

  it("refuses a repository the project does not have", async () => {
    await expect(
      authorizeLoopRepositories({
        ...base,
        primary: { fullName: "acme/api" },
        additionalRepos: [{ fullName: "acme/secrets", branch: "main" }],
      })
    ).rejects.toBeInstanceOf(RepoNotInProjectPoolError);
  });

  it("keeps the GitHub App rules for a project without project repositories", async () => {
    mocks.checkouts = [];
    mocks.teamRepos = [{ repository: { fullName: "acme/api" } }];
    const additionalRepos = [{ fullName: "acme/web", branch: "main" }];

    await expect(
      authorizeLoopRepositories({
        ...base,
        primary: { fullName: "acme/api" },
        additionalRepos,
      })
    ).rejects.toBeInstanceOf(RepoNotInProjectPoolError);
    expect(mocks.authorizeAdditionalRepos).toHaveBeenCalledWith(
      additionalRepos,
      ORG_ID
    );

    await authorizeLoopRepositories({
      ...base,
      primary: undefined,
      additionalRepos,
      checkTeamPool: false,
    });
  });
});
