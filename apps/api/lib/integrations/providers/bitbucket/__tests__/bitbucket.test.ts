import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createFakeAdo as createRoutedFetch,
  type FakeRoute,
  type FakeAdo as RoutedFetch,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  BITBUCKET_TOKEN_REJECTED_MESSAGE,
  type BitbucketContext,
} from "@/lib/integrations/providers/bitbucket/client";
import { validateBitbucketConnection } from "@/lib/integrations/providers/bitbucket/connection";
import { BitbucketActionType } from "@/lib/integrations/providers/bitbucket/constants";
import { bitbucketProvider } from "@/lib/integrations/providers/bitbucket/provider";
import { bitbucketRepositories } from "@/lib/integrations/providers/bitbucket/repositories";
import {
  BITBUCKET_DEFAULT_API_URL,
  normalizeApiUrl,
} from "@/lib/integrations/providers/bitbucket/schemas";
import { HttpMethod, type RepositoryInfo } from "@/lib/integrations/types";

const ANY_REPOSITORY_RE = /^\/2\.0\/repositories\//;
const TOKEN = "ATATT3xFfGF0-bitbucket-api-token-test";
const WORKSPACE_UUID = "{470c176d-3574-44ea-bb41-89e8638bcca4}";
const SHOP_UUID = "{2b0d6d22-6a43-4c0b-9e0e-0f1d2c3b4a59}";
const API_UUID = "{8f3a1c2e-9b7d-4e6f-a5c4-3b2a1f0e9d8c}";

/** Repository as GET /repositories/{workspace}[/{repo}] returns it. */
function bitbucketRepository(
  uuid: string,
  slug: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "repository",
    uuid,
    full_name: `acme/${slug}`,
    name: slug.toUpperCase(),
    slug,
    is_private: true,
    workspace: { type: "workspace", uuid: WORKSPACE_UUID, slug: "acme" },
    mainbranch: { type: "branch", name: "main" },
    links: {
      html: { href: `https://bitbucket.org/acme/${slug}` },
      clone: [
        {
          name: "https",
          href: `https://agentflow-bot@bitbucket.org/acme/${slug}.git`,
        },
        { name: "ssh", href: `git@bitbucket.org:acme/${slug}.git` },
      ],
    },
    ...overrides,
  };
}

const shop: RepositoryInfo = {
  externalId: `${WORKSPACE_UUID}/${SHOP_UUID}`,
  fullName: "acme/shop",
  name: "shop",
  namespace: "acme",
  defaultBranch: "main",
  webUrl: "https://bitbucket.org/acme/shop",
  isPrivate: true,
  cloneUrl: "https://bitbucket.org/acme/shop.git",
};

function createContext(fake: RoutedFetch, workspace = ""): BitbucketContext {
  return {
    connection: {
      id: "0199a5f0-0000-7000-8000-0000000000e1",
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: IntegrationProviderKey.Bitbucket,
      name: "Bitbucket",
      config: { apiUrl: BITBUCKET_DEFAULT_API_URL, workspace },
      secrets: { token: TOKEN },
      account: null,
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-06T11:00:00.000Z"),
  };
}

const USER_ROUTE: FakeRoute = {
  method: HttpMethod.Get,
  path: "/2.0/user",
  json: {
    type: "user",
    uuid: "{d301aafa-d676-4ee0-88be-962be7417567}",
    display_name: "AgentFlow Bot",
    nickname: "agentflow-bot",
  },
};

describe("bitbucketProvider", () => {
  it("offers repositories and the create pull request action", () => {
    expect(bitbucketProvider.key).toBe(IntegrationProviderKey.Bitbucket);
    expect(bitbucketProvider.repositories).toBe(bitbucketRepositories);
    expect(bitbucketProvider.actions.map((action) => action.key)).toEqual([
      BitbucketActionType.CreatePullRequest,
    ]);
    expect(bitbucketProvider.triggers).toEqual([]);
  });

  it("only talks to Bitbucket Cloud (or a local host in tests)", () => {
    const schema = bitbucketProvider.connection.configSchema;
    expect(schema.parse({})).toEqual({
      apiUrl: BITBUCKET_DEFAULT_API_URL,
      workspace: "",
    });
    expect(normalizeApiUrl("https://api.bitbucket.org/2.0/")).toBe(
      BITBUCKET_DEFAULT_API_URL
    );
    expect(normalizeApiUrl("https://bitbucket.contoso.com/rest")).toBeNull();
    expect(normalizeApiUrl("http://api.bitbucket.org/2.0")).toBeNull();
    expect(normalizeApiUrl("http://localhost:4012/2.0")).toBe(
      "http://localhost:4012/2.0"
    );
    expect(schema.safeParse({ workspace: "acme team" }).success).toBe(false);
  });
});

describe("validateBitbucketConnection", () => {
  it("identifies the API token's account with a bearer token", async () => {
    const fake = createRoutedFetch([USER_ROUTE]);

    const result = await validateBitbucketConnection(createContext(fake));

    expect(result).toEqual({
      ok: true,
      config: { apiUrl: BITBUCKET_DEFAULT_API_URL, workspace: "" },
      account: {
        externalAccountId: "{d301aafa-d676-4ee0-88be-962be7417567}",
        displayName: "AgentFlow Bot",
        aliases: ["agentflow-bot"],
        details: { workspace: null, apiUrl: BITBUCKET_DEFAULT_API_URL },
      },
    });
    expect(fake.requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${TOKEN}`
    );
  });

  it("reports a rejected token without echoing it", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Get, path: "/2.0/user", status: 401, json: {} },
    ]);

    const result = await validateBitbucketConnection(createContext(fake));

    expect(result).toEqual({
      ok: false,
      error: `${BITBUCKET_TOKEN_REJECTED_MESSAGE}. For a workspace, project or repository access token, set the workspace`,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("accepts an access token on its workspace, named after it", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/acme",
        json: { values: [bitbucketRepository(SHOP_UUID, "shop")] },
      },
      {
        method: HttpMethod.Get,
        path: "/2.0/user",
        status: 403,
        json: { type: "error", error: { message: "Access token has no user" } },
      },
    ]);

    const result = await validateBitbucketConnection(
      createContext(fake, "acme")
    );

    expect(result).toMatchObject({
      ok: true,
      config: { workspace: "acme" },
      account: {
        externalAccountId: "workspace:acme",
        displayName: "acme (access token)",
      },
    });
  });

  it("fails when the workspace is not accessible", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/other",
        status: 404,
        json: { type: "error", error: { message: "No such workspace" } },
      },
    ]);

    const result = await validateBitbucketConnection(
      createContext(fake, "other")
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Not found on Bitbucket, or the token cannot access it: No such workspace",
    });
  });
});

describe("bitbucketRepositories.list", () => {
  it("goes through every workspace of the account, member repositories only", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/2.0/user/workspaces",
        json: {
          values: [
            { type: "workspace_access", workspace: { slug: "beta" } },
            { type: "workspace_access", workspace: { slug: "acme" } },
          ],
        },
      },
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/acme",
        query: { role: "member", page: "2" },
        json: { values: [bitbucketRepository(API_UUID, "api")] },
      },
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/acme",
        query: { role: "member" },
        json: {
          values: [bitbucketRepository(SHOP_UUID, "shop"), { broken: true }],
          next: `${BITBUCKET_DEFAULT_API_URL}/repositories/acme?role=member&page=2`,
        },
      },
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/beta",
        json: { values: [] },
      },
    ]);

    const repositories = await bitbucketRepositories.list(createContext(fake), {
      query: null,
      limit: 50,
    });

    expect(repositories).toEqual([
      shop,
      expect.objectContaining({
        externalId: `${WORKSPACE_UUID}/${API_UUID}`,
        fullName: "acme/api",
      }),
    ]);
    expect(
      fake.requests.map((request) => request.url.pathname + request.url.search)
    ).toEqual([
      "/2.0/user/workspaces?pagelen=100",
      "/2.0/repositories/acme?pagelen=100&sort=full_name&role=member",
      "/2.0/repositories/acme?role=member&page=2",
      "/2.0/repositories/beta?pagelen=100&sort=full_name&role=member",
    ]);
  });

  it("lists the configured workspace only, filtered by name", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/acme",
        json: { values: [bitbucketRepository(SHOP_UUID, "shop")] },
      },
    ]);

    await bitbucketRepositories.list(createContext(fake, "acme"), {
      query: 'sh"op',
      limit: 50,
    });

    const [request] = fake.requests;
    expect(request?.url.pathname).toBe("/2.0/repositories/acme");
    expect(request?.url.searchParams.get("role")).toBeNull();
    expect(request?.url.searchParams.get("q")).toBe(
      String.raw`full_name ~ "sh\"op"`
    );
  });

  it("never follows a next link outside the API", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/2.0/repositories/acme",
        json: {
          values: [],
          next: "https://attacker.example.com/2.0/repositories/acme?page=2",
        },
      },
    ]);

    await expect(
      bitbucketRepositories.list(createContext(fake, "acme"), {
        query: null,
        limit: 50,
      })
    ).rejects.toThrow("Bitbucket returned a link outside its API");
    expect(
      fake.requests.every((request) => request.url.host === "api.bitbucket.org")
    ).toBe(true);
  });
});

describe("bitbucketRepositories.get and gitCredential", () => {
  it("reads a repository by its workspace and repository UUIDs", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: `/2.0/repositories/${encodeURIComponent(WORKSPACE_UUID)}/${encodeURIComponent(SHOP_UUID)}`,
        json: bitbucketRepository(SHOP_UUID, "shop"),
      },
    ]);

    expect(
      await bitbucketRepositories.get(createContext(fake), shop.externalId)
    ).toEqual(shop);
  });

  it("is null for a malformed id (no request) and a missing repository", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: ANY_REPOSITORY_RE,
        status: 404,
        json: { type: "error", error: { message: "Repository not found" } },
      },
    ]);

    expect(
      await bitbucketRepositories.get(createContext(fake), "acme/shop")
    ).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(
      await bitbucketRepositories.get(createContext(fake), shop.externalId)
    ).toBeNull();
  });

  it("issues the token with the static git user name", async () => {
    const fake = createRoutedFetch([]);

    expect(
      await bitbucketRepositories.gitCredential(createContext(fake), shop)
    ).toEqual({ username: "x-token-auth", password: TOKEN, expiresAt: null });
  });
});

describe("bitbucketRepositories.createPullRequest", () => {
  const request = {
    repository: shop,
    sourceBranch: "symphony/iss-7",
    targetBranch: "main",
    title: "ISS-7: Export orders as CSV",
    description: "Resolves ISS-7",
    draft: false,
  };
  const PULL_REQUESTS = "/2.0/repositories/acme/shop/pullrequests";
  const pullRequest = (id: number) => ({
    type: "pullrequest",
    id,
    links: {
      html: { href: `https://bitbucket.org/acme/shop/pull-requests/${id}` },
    },
  });

  it("opens a pull request from the source into the destination branch", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: PULL_REQUESTS,
        json: { values: [] },
      },
      {
        method: HttpMethod.Post,
        path: PULL_REQUESTS,
        status: 201,
        json: pullRequest(12),
      },
    ]);

    const result = await bitbucketRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toEqual({
      ok: true,
      value: {
        url: "https://bitbucket.org/acme/shop/pull-requests/12",
        number: 12,
        externalId: "12",
        existing: false,
      },
    });
    const [lookup, create] = fake.requests;
    expect(lookup?.url.searchParams.get("q")).toBe(
      'source.branch.name = "symphony/iss-7" AND destination.branch.name = "main"'
    );
    expect(lookup?.url.searchParams.get("state")).toBe("OPEN");
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      title: "ISS-7: Export orders as CSV",
      description: "Resolves ISS-7",
      source: { branch: { name: "symphony/iss-7" } },
      destination: { branch: { name: "main" } },
      close_source_branch: false,
    });
  });

  it("reuses the open pull request of the same branches", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: PULL_REQUESTS,
        json: { values: [pullRequest(9)] },
      },
    ]);

    const result = await bitbucketRepositories.createPullRequest(
      createContext(fake),
      { ...request, draft: true }
    );

    expect(result).toMatchObject({
      ok: true,
      value: { number: 9, existing: true },
    });
    expect(fake.requestsTo(HttpMethod.Post, PULL_REQUESTS)).toHaveLength(0);
  });

  it("sends draft when asked and reports Bitbucket's reason", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Get, path: PULL_REQUESTS, json: { values: [] } },
      {
        method: HttpMethod.Post,
        path: PULL_REQUESTS,
        status: 400,
        json: {
          type: "error",
          error: { message: "There are no changes to be pulled" },
        },
      },
    ]);

    const result = await bitbucketRepositories.createPullRequest(
      createContext(fake),
      { ...request, draft: true }
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Bitbucket rejected the request: There are no changes to be pulled",
      retryable: false,
    });
    const create = fake.requestsTo(HttpMethod.Post, PULL_REQUESTS)[0];
    expect(JSON.parse(create?.body ?? "{}").draft).toBe(true);
  });
});
