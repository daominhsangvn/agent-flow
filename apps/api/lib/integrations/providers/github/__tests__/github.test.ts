import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createFakeAdo as createRoutedFetch,
  type FakeRoute,
  type FakeAdo as RoutedFetch,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  GITHUB_TOKEN_REJECTED_MESSAGE,
  type GitHubContext,
} from "@/lib/integrations/providers/github/client";
import { validateGitHubConnection } from "@/lib/integrations/providers/github/connection";
import { GitHubActionType } from "@/lib/integrations/providers/github/constants";
import { githubProvider } from "@/lib/integrations/providers/github/provider";
import { githubRepositories } from "@/lib/integrations/providers/github/repositories";
import {
  GITHUB_DEFAULT_API_URL,
  normalizeApiUrl,
} from "@/lib/integrations/providers/github/schemas";
import { HttpMethod, type RepositoryInfo } from "@/lib/integrations/types";

const TOKEN = "github_pat_11ABCDEFG0123456789_test";
const REPO_ID = 1_296_269;

/** Repository as GET /repositories/{id} and /user/repos return it. */
function githubRepository(
  id: number,
  fullName: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    id,
    node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    name,
    full_name: fullName,
    owner: { login: owner, id: 1, type: "Organization" },
    private: true,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    default_branch: "main",
    archived: false,
    disabled: false,
    permissions: { admin: false, push: true, pull: true },
    ...overrides,
  };
}

const shop: RepositoryInfo = {
  externalId: String(REPO_ID),
  fullName: "contoso/shop",
  name: "shop",
  namespace: "contoso",
  defaultBranch: "main",
  webUrl: "https://github.com/contoso/shop",
  isPrivate: true,
  cloneUrl: "https://github.com/contoso/shop.git",
};

function createContext(
  fake: RoutedFetch,
  apiUrl = GITHUB_DEFAULT_API_URL
): GitHubContext {
  return {
    connection: {
      id: "0199a5f0-0000-7000-8000-0000000000e1",
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: IntegrationProviderKey.GitHub,
      name: "GitHub",
      config: { apiUrl },
      secrets: { token: TOKEN },
      account: null,
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-05T11:00:00.000Z"),
  };
}

describe("githubProvider", () => {
  it("offers repositories and the create pull request action", () => {
    expect(githubProvider.key).toBe(IntegrationProviderKey.GitHub);
    expect(githubProvider.repositories).toBe(githubRepositories);
    expect(githubProvider.actions.map((action) => action.key)).toEqual([
      GitHubActionType.CreatePullRequest,
    ]);
    expect(githubProvider.triggers).toEqual([]);
  });

  it("defaults the API URL to github.com and rejects unsafe URLs", () => {
    expect(githubProvider.connection.configSchema.parse({})).toEqual({
      apiUrl: GITHUB_DEFAULT_API_URL,
    });
    expect(normalizeApiUrl("https://ghe.contoso.com/api/v3/")).toBe(
      "https://ghe.contoso.com/api/v3"
    );
    expect(normalizeApiUrl("http://ghe.contoso.com/api/v3")).toBeNull();
    expect(normalizeApiUrl("https://user:pass@ghe.contoso.com")).toBeNull();
    expect(normalizeApiUrl("http://localhost:4010")).toBe(
      "http://localhost:4010"
    );
  });
});

describe("validateGitHubConnection", () => {
  it("identifies the token owner with the token as a bearer token", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/user",
        json: { id: 583_231, login: "agentflow-bot", name: "AgentFlow Bot" },
      },
    ]);

    const result = await validateGitHubConnection(createContext(fake));

    expect(result).toEqual({
      ok: true,
      config: { apiUrl: GITHUB_DEFAULT_API_URL },
      account: {
        externalAccountId: "583231",
        displayName: "AgentFlow Bot",
        aliases: ["agentflow-bot"],
        details: { login: "agentflow-bot", apiUrl: GITHUB_DEFAULT_API_URL },
      },
    });
    const [request] = fake.requests;
    expect(request?.url.origin).toBe("https://api.github.com");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("reports a rejected token", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/user",
        status: 401,
        json: { message: "Bad credentials" },
      },
    ]);

    await expect(
      validateGitHubConnection(createContext(fake))
    ).resolves.toEqual({ ok: false, error: GITHUB_TOKEN_REJECTED_MESSAGE });
  });
});

describe("githubRepositories.list", () => {
  it("pages through /user/repos, leaves out archived repositories and filters by name", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubRepository(1000 + index, `contoso/service-${index}`, {
        archived: index === 0,
      })
    );
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/user/repos",
        query: { page: "1" },
        json: firstPage,
      },
      {
        method: HttpMethod.Get,
        path: "/user/repos",
        query: { page: "2" },
        json: [githubRepository(REPO_ID, "contoso/shop"), { id: "bad" }],
      },
    ]);

    const all = await githubRepositories.list(createContext(fake), {
      query: null,
      limit: 100,
    });
    const filtered = await githubRepositories.list(createContext(fake), {
      query: "SHOP",
      limit: 100,
    });

    expect(all).toHaveLength(100);
    expect(all.map((repository) => repository.name)).not.toContain("service-0");
    expect(filtered).toEqual([shop]);
    const [first] = fake.requestsTo(HttpMethod.Get, "/user/repos");
    expect(first?.url.searchParams.get("per_page")).toBe("100");
  });

  it("throws the GitHub error message", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/user/repos",
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
    ]);

    await expect(
      githubRepositories.list(createContext(fake), { query: null, limit: 10 })
    ).rejects.toThrow("Resource not accessible by personal access token");
  });
});

describe("githubRepositories.get / gitCredential", () => {
  it("reads a repository by id and returns null when missing or archived", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: `/repositories/${REPO_ID}`,
        json: githubRepository(REPO_ID, "contoso/shop"),
      },
      {
        method: HttpMethod.Get,
        path: "/repositories/2",
        json: githubRepository(2, "contoso/old", { archived: true }),
      },
      {
        method: HttpMethod.Get,
        path: "/repositories/3",
        status: 404,
        json: { message: "Not Found" },
      },
    ]);
    const ctx = createContext(fake);

    await expect(githubRepositories.get(ctx, String(REPO_ID))).resolves.toEqual(
      shop
    );
    await expect(githubRepositories.get(ctx, "2")).resolves.toBeNull();
    await expect(githubRepositories.get(ctx, "3")).resolves.toBeNull();
    await expect(githubRepositories.get(ctx, "../user")).resolves.toBeNull();
    expect(fake.requests).toHaveLength(3);
  });

  it("issues the token as an x-access-token credential", async () => {
    await expect(
      githubRepositories.gitCredential(
        createContext(createRoutedFetch([])),
        shop
      )
    ).resolves.toEqual({
      username: "x-access-token",
      password: TOKEN,
      expiresAt: null,
    });
  });
});

describe("githubRepositories.createPullRequest", () => {
  const request = {
    repository: shop,
    sourceBranch: "feat/csv-export",
    targetBranch: "main",
    title: "SHOP-42: Export orders as CSV",
    description: "Resolves SHOP-42",
    draft: false,
  };
  const noOpenPullRequest: FakeRoute = {
    method: HttpMethod.Get,
    path: "/repos/contoso/shop/pulls",
    json: [],
  };
  const openPullRequest: FakeRoute = {
    method: HttpMethod.Get,
    path: "/repos/contoso/shop/pulls",
    json: [
      {
        id: 987_653,
        number: 41,
        html_url: "https://github.com/contoso/shop/pull/41",
      },
    ],
  };

  it("opens a pull request when none is open for the branch", async () => {
    const fake = createRoutedFetch([
      noOpenPullRequest,
      {
        method: HttpMethod.Post,
        path: "/repos/contoso/shop/pulls",
        status: 201,
        json: {
          id: 987_654,
          number: 42,
          html_url: "https://github.com/contoso/shop/pull/42",
        },
      },
    ]);

    const result = await githubRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toEqual({
      ok: true,
      value: {
        url: "https://github.com/contoso/shop/pull/42",
        number: 42,
        externalId: "987654",
        existing: false,
      },
    });
    const [search] = fake.requestsTo(
      HttpMethod.Get,
      "/repos/contoso/shop/pulls"
    );
    expect(search?.url.searchParams.get("head")).toBe(
      "contoso:feat/csv-export"
    );
    expect(search?.url.searchParams.get("state")).toBe("open");
    const [create] = fake.requestsTo(
      HttpMethod.Post,
      "/repos/contoso/shop/pulls"
    );
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      title: request.title,
      body: request.description,
      head: "feat/csv-export",
      base: "main",
      draft: false,
    });
  });

  it("reuses the open pull request of the branch", async () => {
    const fake = createRoutedFetch([openPullRequest]);

    const result = await githubRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result.ok && result.value).toMatchObject({
      number: 41,
      existing: true,
    });
    expect(
      fake.requestsTo(HttpMethod.Post, "/repos/contoso/shop/pulls")
    ).toEqual([]);
  });

  it("reports validation errors with GitHub's detail", async () => {
    const fake = createRoutedFetch([
      noOpenPullRequest,
      {
        method: HttpMethod.Post,
        path: "/repos/contoso/shop/pulls",
        status: 422,
        json: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "No commits between main and feat/csv-export",
            },
          ],
        },
      },
    ]);

    const result = await githubRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toEqual({
      ok: false,
      error:
        "GitHub rejected the request: Validation Failed: No commits between main and feat/csv-export",
      retryable: false,
    });
  });

  it("treats a rate limit as retryable", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/repos/contoso/shop/pulls",
        status: 429,
        json: { message: "API rate limit exceeded" },
      },
    ]);

    const result = await githubRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toEqual({
      ok: false,
      error: "GitHub rate limit reached: API rate limit exceeded",
      retryable: true,
    });
  });
});
