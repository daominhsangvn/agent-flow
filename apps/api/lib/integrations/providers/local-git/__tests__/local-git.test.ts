import {
  IntegrationCapability,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttp } from "@/lib/integrations/http";
import {
  createFakeAdo as createRoutedFetch,
  type FakeRoute,
  type FakeAdo as RoutedFetch,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import {
  LOCAL_GIT_TOKEN_REJECTED_MESSAGE,
  type LocalGitContext,
} from "@/lib/integrations/providers/local-git/client";
import { validateLocalGitConnection } from "@/lib/integrations/providers/local-git/connection";
import { LocalGitActionType } from "@/lib/integrations/providers/local-git/constants";
import { localGitProvider } from "@/lib/integrations/providers/local-git/provider";
import { localGitRepositories } from "@/lib/integrations/providers/local-git/repositories";
import {
  LOCAL_GIT_DEFAULT_URL,
  type LocalGitConnectionConfig,
  normalizeBaseUrl,
} from "@/lib/integrations/providers/local-git/schemas";
import { toProviderSummary } from "@/lib/integrations/registry";
import { HttpMethod, type RepositoryInfo } from "@/lib/integrations/types";

const TOKEN = "3f1c0d9a8b7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const SERVER = "http://localhost:3300";
const RUNNER = "http://host.docker.internal:3300";
const PULLS_PATH_RE = /pulls$/;
const REPOS_PATH_RE = /repos$/;

/** Repository as Gitea's API returns it. */
function giteaRepository(
  id: number,
  owner: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    private: true,
    empty: false,
    default_branch: "main",
    html_url: `${SERVER}/${owner}/${name}`,
    clone_url: `${SERVER}/${owner}/${name}.git`,
    owner: { id: 7, login: owner },
    ...overrides,
  };
}

const devkit: RepositoryInfo = {
  externalId: "4",
  fullName: "contoso/devkit",
  name: "devkit",
  namespace: "contoso",
  defaultBranch: "main",
  webUrl: `${SERVER}/contoso/devkit`,
  isPrivate: true,
  cloneUrl: `${RUNNER}/contoso/devkit.git`,
};

function createContext(
  fake: RoutedFetch,
  config: Partial<LocalGitConnectionConfig> = {}
): LocalGitContext {
  return {
    connection: {
      id: "0199a5f0-0000-7000-8000-0000000000f1",
      organizationId: "0199a5f0-0000-7000-8000-00000000000a",
      provider: IntegrationProviderKey.LocalGit,
      name: "Local Git",
      config: { serverUrl: SERVER, runnerUrl: RUNNER, owner: "", ...config },
      secrets: { token: TOKEN },
      account: null,
    },
    http: createProviderHttp(fake.fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-09T11:00:00.000Z"),
  };
}

const USER_ROUTE: FakeRoute = {
  method: HttpMethod.Get,
  path: "/api/v1/user",
  json: { id: 1, login: "agentflow", full_name: "AgentFlow" },
};

describe("localGitProvider", () => {
  it("offers repositories, their creation and the create pull request action", () => {
    expect(localGitProvider.key).toBe(IntegrationProviderKey.LocalGit);
    expect(localGitProvider.repositories).toBe(localGitRepositories);
    expect(localGitProvider.actions.map((action) => action.key)).toEqual([
      LocalGitActionType.CreatePullRequest,
    ]);
    expect(localGitProvider.triggers).toEqual([]);
    expect(toProviderSummary(localGitProvider).capabilities).toEqual([
      IntegrationCapability.Actions,
      IntegrationCapability.Repositories,
      IntegrationCapability.RepositoryCreation,
    ]);
  });

  it("defaults to the compose address and normalizes URLs", () => {
    const schema = localGitProvider.connection.configSchema;
    expect(schema.parse({})).toEqual({
      serverUrl: LOCAL_GIT_DEFAULT_URL,
      runnerUrl: "",
      owner: "",
    });
    expect(
      schema.parse({
        serverUrl: "http://git.lan:3300/",
        runnerUrl: "http://host.docker.internal:3300//",
        owner: "contoso",
      })
    ).toEqual({
      serverUrl: "http://git.lan:3300",
      runnerUrl: "http://host.docker.internal:3300",
      owner: "contoso",
    });
    expect(normalizeBaseUrl("ftp://git.lan")).toBeNull();
    expect(normalizeBaseUrl("http://user:pw@git.lan")).toBeNull();
    expect(schema.safeParse({ owner: "two words" }).success).toBe(false);
    expect(schema.safeParse({ runnerUrl: "not a url" }).success).toBe(false);
  });
});

describe("validateLocalGitConnection", () => {
  it("identifies the token's account with Gitea's token header", async () => {
    const fake = createRoutedFetch([USER_ROUTE]);

    const result = await validateLocalGitConnection(createContext(fake));

    expect(result).toEqual({
      ok: true,
      config: { serverUrl: SERVER, runnerUrl: RUNNER, owner: "" },
      account: {
        externalAccountId: "1",
        displayName: "AgentFlow",
        aliases: ["agentflow"],
        details: { serverUrl: SERVER, owner: null },
      },
    });
    expect(fake.requests[0]?.headers.get("authorization")).toBe(
      `token ${TOKEN}`
    );
  });

  it("checks that the owner exists", async () => {
    const fake = createRoutedFetch([
      USER_ROUTE,
      {
        method: HttpMethod.Get,
        path: "/api/v1/users/nobody",
        status: 404,
        json: { message: "user redirect does not exist" },
      },
    ]);

    const result = await validateLocalGitConnection(
      createContext(fake, { owner: "nobody" })
    );

    expect(result).toEqual({
      ok: false,
      error: 'No user or organization "nobody" on Local Git',
    });
  });

  it("reports a rejected token without echoing it", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Get, path: "/api/v1/user", status: 401, json: {} },
    ]);

    const result = await validateLocalGitConnection(createContext(fake));

    expect(result).toEqual({
      ok: false,
      error: LOCAL_GIT_TOKEN_REJECTED_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("says how to start Local Git when it does not answer", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Get, path: "/api/v1/user", networkError: true },
    ]);

    const result = await validateLocalGitConnection(createContext(fake));

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain(
      "docker compose up -d local-git"
    );
  });
});

describe("localGitRepositories.list", () => {
  it("searches every repository the token can access, alphabetically, with runner clone URLs", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/repos/search",
        json: {
          ok: true,
          data: [
            giteaRepository(4, "contoso", "devkit"),
            { id: "broken" },
            giteaRepository(5, "agentflow", "scratch", { private: false }),
          ],
        },
      },
    ]);

    const repositories = await localGitRepositories.list(createContext(fake), {
      query: " dev ",
      limit: 10,
    });

    expect(repositories).toEqual([
      devkit,
      {
        externalId: "5",
        fullName: "agentflow/scratch",
        name: "scratch",
        namespace: "agentflow",
        defaultBranch: "main",
        webUrl: `${SERVER}/agentflow/scratch`,
        isPrivate: false,
        cloneUrl: `${RUNNER}/agentflow/scratch.git`,
      },
    ]);
    const search = fake.requests[0]?.url;
    expect(search?.searchParams.get("q")).toBe("dev");
    expect(search?.searchParams.get("sort")).toBe("alpha");
    expect(search?.searchParams.has("uid")).toBe(false);
  });

  it("lists only the owner's repositories when the connection has one", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/users/contoso",
        json: { id: 7, login: "contoso" },
      },
      {
        method: HttpMethod.Get,
        path: "/api/v1/repos/search",
        query: { uid: "7", exclusive: "true" },
        json: { ok: true, data: [giteaRepository(4, "contoso", "devkit")] },
      },
    ]);

    const repositories = await localGitRepositories.list(
      createContext(fake, { owner: "contoso" }),
      { query: null, limit: 10 }
    );

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "contoso/devkit",
    ]);
  });

  it("keeps Gitea's clone URL without a runner URL", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/repos/search",
        json: { ok: true, data: [giteaRepository(4, "contoso", "devkit")] },
      },
    ]);

    const [repository] = await localGitRepositories.list(
      createContext(fake, { runnerUrl: "" }),
      { query: null, limit: 10 }
    );

    expect(repository?.cloneUrl).toBe(`${SERVER}/contoso/devkit.git`);
  });
});

describe("localGitRepositories.get", () => {
  it("reads a repository by its numeric id", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/repositories/4",
        json: giteaRepository(4, "contoso", "devkit"),
      },
    ]);

    await expect(
      localGitRepositories.get(createContext(fake), "4")
    ).resolves.toEqual(devkit);
  });

  it("answers null for a deleted repository and for foreign ids", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/repositories/9",
        status: 404,
        json: { message: "not found" },
      },
    ]);

    await expect(
      localGitRepositories.get(createContext(fake), "9")
    ).resolves.toBeNull();
    await expect(
      localGitRepositories.get(createContext(fake), "../admin")
    ).resolves.toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it("has no default branch while the repository is empty", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/repositories/4",
        json: giteaRepository(4, "contoso", "devkit", { empty: true }),
      },
    ]);

    const repository = await localGitRepositories.get(createContext(fake), "4");

    expect(repository?.defaultBranch).toBeNull();
  });
});

describe("localGitRepositories.gitCredential", () => {
  it("issues the connection's token as the password", async () => {
    const fake = createRoutedFetch([]);

    await expect(
      localGitRepositories.gitCredential(createContext(fake), devkit)
    ).resolves.toEqual({
      username: "agentflow",
      password: TOKEN,
      expiresAt: null,
    });
  });
});

describe("localGitRepositories.createPullRequest", () => {
  const request = {
    repository: devkit,
    sourceBranch: "feature/iss-36",
    targetBranch: "main",
    title: "TF-10: Release 1.0",
    description: "Resolves TF-10",
    draft: false,
  };
  const existingPath =
    "/api/v1/repos/contoso/devkit/pulls/main/feature%2Fiss-36";

  it("opens a pull request from the pushed branch", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: existingPath,
        status: 404,
        json: { message: "pull request does not exist" },
      },
      {
        method: HttpMethod.Post,
        path: "/api/v1/repos/contoso/devkit/pulls",
        status: 201,
        json: {
          id: 31,
          number: 3,
          state: "open",
          html_url: `${SERVER}/contoso/devkit/pulls/3`,
        },
      },
    ]);

    const result = await localGitRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toEqual({
      ok: true,
      value: {
        url: `${SERVER}/contoso/devkit/pulls/3`,
        number: 3,
        externalId: "31",
        existing: false,
      },
    });
    expect(
      JSON.parse(
        fake.requestsTo(
          HttpMethod.Post,
          "/api/v1/repos/contoso/devkit/pulls"
        )[0]?.body ?? "{}"
      )
    ).toEqual({
      head: "feature/iss-36",
      base: "main",
      title: "TF-10: Release 1.0",
      body: "Resolves TF-10",
    });
  });

  it("marks a draft as work in progress", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Get, path: existingPath, status: 404, json: {} },
      {
        method: HttpMethod.Post,
        path: "/api/v1/repos/contoso/devkit/pulls",
        status: 201,
        json: {
          id: 31,
          number: 3,
          state: "open",
          html_url: `${SERVER}/contoso/devkit/pulls/3`,
        },
      },
    ]);

    await localGitRepositories.createPullRequest(createContext(fake), {
      ...request,
      draft: true,
    });

    expect(
      JSON.parse(
        fake.requestsTo(
          HttpMethod.Post,
          "/api/v1/repos/contoso/devkit/pulls"
        )[0]?.body ?? "{}"
      ).title
    ).toBe("WIP: TF-10: Release 1.0");
  });

  it("reuses the open pull request of the same branches", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: existingPath,
        json: {
          id: 30,
          number: 2,
          state: "open",
          html_url: `${SERVER}/contoso/devkit/pulls/2`,
        },
      },
    ]);

    const result = await localGitRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toMatchObject({
      ok: true,
      value: { number: 2, existing: true },
    });
    expect(fake.requestsTo(HttpMethod.Post, PULLS_PATH_RE)).toHaveLength(0);
  });

  it("opens a new one when the earlier pull request of the branches was merged", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: existingPath,
        json: {
          id: 30,
          number: 2,
          state: "closed",
          html_url: `${SERVER}/contoso/devkit/pulls/2`,
        },
      },
      {
        method: HttpMethod.Post,
        path: "/api/v1/repos/contoso/devkit/pulls",
        status: 201,
        json: {
          id: 32,
          number: 4,
          state: "open",
          html_url: `${SERVER}/contoso/devkit/pulls/4`,
        },
      },
    ]);

    const result = await localGitRepositories.createPullRequest(
      createContext(fake),
      request
    );

    expect(result).toMatchObject({
      ok: true,
      value: { number: 4, existing: false },
    });
  });
});

describe("localGitRepositories.create", () => {
  const created = {
    status: 201,
    json: giteaRepository(12, "agentflow", "notes"),
  };

  it("creates an initialized private repository in the token's account", async () => {
    const fake = createRoutedFetch([
      { method: HttpMethod.Post, path: "/api/v1/user/repos", ...created },
    ]);

    const result = await localGitRepositories.create?.(createContext(fake), {
      name: "notes",
      description: "Team notes",
      isPrivate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        externalId: "12",
        fullName: "agentflow/notes",
        defaultBranch: "main",
        cloneUrl: `${RUNNER}/agentflow/notes.git`,
      },
    });
    expect(
      JSON.parse(
        fake.requestsTo(HttpMethod.Post, "/api/v1/user/repos")[0]?.body ?? "{}"
      )
    ).toEqual({
      name: "notes",
      description: "Team notes",
      private: true,
      auto_init: true,
      default_branch: "main",
      readme: "Default",
    });
  });

  it("creates it in the owner organization", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/orgs/contoso",
        json: { id: 7, username: "contoso" },
      },
      {
        method: HttpMethod.Post,
        path: "/api/v1/orgs/contoso/repos",
        ...created,
      },
    ]);

    const result = await localGitRepositories.create?.(
      createContext(fake, { owner: "contoso" }),
      { name: "notes", description: "", isPrivate: true }
    );

    expect(result?.ok).toBe(true);
    expect(
      fake.requestsTo(HttpMethod.Post, "/api/v1/orgs/contoso/repos")
    ).toHaveLength(1);
  });

  it("refuses another user's account as the owner", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Get,
        path: "/api/v1/orgs/alice",
        status: 404,
        json: { message: "GetOrgByName" },
      },
      USER_ROUTE,
    ]);

    const result = await localGitRepositories.create?.(
      createContext(fake, { owner: "alice" }),
      { name: "notes", description: "", isPrivate: true }
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.requestsTo(HttpMethod.Post, REPOS_PATH_RE)).toHaveLength(0);
  });

  it("says when the name is taken", async () => {
    const fake = createRoutedFetch([
      {
        method: HttpMethod.Post,
        path: "/api/v1/user/repos",
        status: 409,
        json: { message: "The repository with the same name already exists." },
      },
    ]);

    const result = await localGitRepositories.create?.(createContext(fake), {
      name: "notes",
      description: "",
      isPrivate: true,
    });

    expect(result).toEqual({
      ok: false,
      error: 'A repository named "notes" already exists',
      retryable: false,
    });
  });
});
