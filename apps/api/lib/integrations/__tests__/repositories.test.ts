import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectionRepository,
  getConnectionRepository,
  listConnectionRepositories,
  loadRepositoryConnection,
} from "@/lib/integrations/repositories";
import type { RepositoryInfo } from "@/lib/integrations/types";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";

const shop: RepositoryInfo = {
  externalId: "1296269",
  fullName: "contoso/shop",
  name: "shop",
  namespace: "contoso",
  defaultBranch: "main",
  webUrl: "https://github.com/contoso/shop",
  isPrivate: true,
  cloneUrl: "https://github.com/contoso/shop.git",
};

const mocks = vi.hoisted(() => ({
  loaded: null as unknown,
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: vi.fn(() => Promise.resolve(mocks.loaded)),
  createProviderContext: vi.fn((runtime: unknown) => ({ connection: runtime })),
}));

function loadedConnection(
  overrides: { status?: string; repositories?: unknown } = {}
) {
  return {
    record: {
      id: CONNECTION_ID,
      name: "Contoso GitHub",
      provider: "github",
      status: overrides.status ?? IntegrationConnectionStatus.Active,
    },
    provider: {
      displayName: "GitHub",
      repositories:
        "repositories" in overrides
          ? overrides.repositories
          : { list: mocks.list, get: mocks.get },
    },
    runtime: { id: CONNECTION_ID },
  };
}

beforeEach(() => {
  mocks.loaded = loadedConnection();
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.create.mockReset();
});

describe("loadRepositoryConnection", () => {
  it.each([
    ["a missing connection", null, Status.NotFound],
    [
      "a disabled connection",
      loadedConnection({ status: IntegrationConnectionStatus.Disabled }),
      Status.Conflict,
    ],
    [
      "a provider without repositories",
      loadedConnection({ repositories: undefined }),
      Status.BadRequest,
    ],
  ])("refuses %s", async (_case, loaded, status) => {
    mocks.loaded = loaded;

    const result = await loadRepositoryConnection(ORG_ID, CONNECTION_ID);

    expect(result.ok ? null : result.error.status).toBe(status);
  });
});

describe("listConnectionRepositories", () => {
  it("returns the public repository shape without the clone URL", async () => {
    mocks.list.mockResolvedValue([shop]);

    const result = await listConnectionRepositories(ORG_ID, CONNECTION_ID, {
      query: "shop",
      limit: 10,
    });

    expect(result).toEqual({
      ok: true,
      value: [
        {
          externalId: shop.externalId,
          fullName: shop.fullName,
          name: shop.name,
          namespace: shop.namespace,
          defaultBranch: shop.defaultBranch,
          webUrl: shop.webUrl,
          isPrivate: shop.isPrivate,
        },
      ],
    });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), {
      query: "shop",
      limit: 10,
    });
  });

  it("maps a provider failure to a bad gateway with the provider's message", async () => {
    mocks.list.mockRejectedValue(
      new Error("GitHub rejected the personal access token")
    );

    const result = await listConnectionRepositories(ORG_ID, CONNECTION_ID, {
      query: null,
      limit: 10,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.BadGateway,
        message:
          "GitHub could not list repositories: GitHub rejected the personal access token",
      },
    });
  });
});

describe("getConnectionRepository", () => {
  it("returns not found when the connection cannot see the repository", async () => {
    mocks.get.mockResolvedValue(null);
    const connection = await loadRepositoryConnection(ORG_ID, CONNECTION_ID);
    if (!connection.ok) {
      throw new Error("connection expected");
    }

    const result = await getConnectionRepository(connection.value, "42");

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.NotFound,
        message: 'Repository not found, or "Contoso GitHub" cannot access it',
      },
    });
  });
});

describe("createConnectionRepository", () => {
  const input = { name: "shop", description: "", private: true };

  it("creates through a provider that hosts repositories and returns the public shape", async () => {
    mocks.loaded = loadedConnection({
      repositories: { list: mocks.list, get: mocks.get, create: mocks.create },
    });
    mocks.create.mockResolvedValue({ ok: true, value: shop });

    const result = await createConnectionRepository(
      ORG_ID,
      CONNECTION_ID,
      input
    );

    expect(result).toEqual({
      ok: true,
      value: {
        externalId: "1296269",
        fullName: "contoso/shop",
        name: "shop",
        namespace: "contoso",
        defaultBranch: "main",
        webUrl: "https://github.com/contoso/shop",
        isPrivate: true,
      },
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), {
      name: "shop",
      description: "",
      isPrivate: true,
    });
  });

  it("refuses providers that cannot create repositories", async () => {
    const result = await createConnectionRepository(
      ORG_ID,
      CONNECTION_ID,
      input
    );

    expect(result.ok ? null : result.error.status).toBe(Status.BadRequest);
  });

  it.each([
    [false, Status.Conflict],
    [true, Status.BadGateway],
  ])("maps a refusal (retryable %s) to %s with the provider's message", async (retryable, status) => {
    mocks.loaded = loadedConnection({
      repositories: { list: mocks.list, get: mocks.get, create: mocks.create },
    });
    mocks.create.mockResolvedValue({
      ok: false,
      error: 'A repository named "shop" already exists',
      retryable,
    });

    const result = await createConnectionRepository(
      ORG_ID,
      CONNECTION_ID,
      input
    );

    expect(result).toEqual({
      ok: false,
      error: { status, message: 'A repository named "shop" already exists' },
    });
  });
});
