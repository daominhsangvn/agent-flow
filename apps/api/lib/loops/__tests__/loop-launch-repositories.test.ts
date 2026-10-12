import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLaunchRepositories } from "@/lib/loops/loop-launch-repositories";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";

const mocks = vi.hoisted(() => ({
  checkouts: [] as Array<{ fullName: string; cloneUrl: string }>,
  instructions: "",
}));

vi.mock("@/app/projects/project-repository-checkouts", async (original) => ({
  ...(await original<
    typeof import("@/app/projects/project-repository-checkouts")
  >()),
  findDocumentRepositoryCheckouts: vi.fn(() =>
    Promise.resolve({
      projectId: "project-1",
      checkouts: mocks.checkouts,
      instructions: mocks.instructions,
    })
  ),
}));

const loop = {
  repo: { fullName: "acme/api", branch: "main" },
  additionalRepos: [
    { fullName: "acme/web", branch: "develop" },
    { fullName: "acme/legacy", branch: "main" },
  ],
  documentId: "doc-1",
};
const resolveGitHubToken = vi.fn(() => Promise.resolve("ghs_token"));

beforeEach(() => {
  mocks.checkouts = [
    { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" },
    { fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git" },
  ];
  mocks.instructions = "- api: backend";
  resolveGitHubToken.mockClear();
});

describe("resolveLaunchRepositories", () => {
  it("gives a desktop loop the clone URLs of its project repositories", async () => {
    const result = await resolveLaunchRepositories({
      loop,
      organizationId: ORG_ID,
      isDesktop: true,
      resolveGitHubToken,
    });

    expect(result).toEqual({
      repoInfo: {
        fullName: "acme/api",
        branch: "main",
        cloneUrl: "https://github.com/acme/api.git",
      },
      additionalRepos: [
        {
          fullName: "acme/web",
          branch: "develop",
          cloneUrl: "https://github.com/acme/web.git",
        },
        { fullName: "acme/legacy", branch: "main" },
      ],
      projectRepositories: true,
      projectInstructions: "- api: backend",
    });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it("leaves a loop on a GitHub App repository unchanged", async () => {
    mocks.checkouts = [];

    const result = await resolveLaunchRepositories({
      loop,
      organizationId: ORG_ID,
      isDesktop: true,
      resolveGitHubToken,
    });

    expect(result.projectRepositories).toBe(false);
    expect(result.projectInstructions).toBeUndefined();
    expect(result.repoInfo).toBeUndefined();
    expect(result.additionalRepos).toEqual(loop.additionalRepos);
  });

  it("resolves installation tokens for a cloud loop", async () => {
    const result = await resolveLaunchRepositories({
      loop,
      organizationId: ORG_ID,
      isDesktop: false,
      resolveGitHubToken,
    });

    expect(result.projectRepositories).toBe(false);
    expect(result.additionalRepos?.[0]).toEqual({
      fullName: "acme/web",
      branch: "develop",
      githubToken: "ghs_token",
    });
  });
});
