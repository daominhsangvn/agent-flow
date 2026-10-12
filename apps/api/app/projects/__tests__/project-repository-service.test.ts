import { PROJECT_REPOSITORIES_MAX } from "@repo/api/src/types/project-repository";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRepositoryService } from "@/app/projects/project-repository-service";
import type { RepositoryInfo } from "@/lib/integrations/types";

type Row = {
  id: string;
  organizationId: string;
  projectId: string;
  connectionId: string | null;
  provider: string;
  externalId: string;
  fullName: string;
  name: string;
  defaultBranch: string | null;
  webUrl: string;
  cloneUrl: string;
  isPrimary: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  otherOrg: "0199a5f0-0000-7000-8000-00000000000b",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  user: "0199a5f0-0000-7000-8000-0000000000a1",
  connection: "0199a5f0-0000-7000-8000-0000000000e1",
};

const mocks = vi.hoisted(() => ({
  rows: [] as Row[],
  projects: new Set<string>(),
  locks: [] as string[],
  sequence: 0,
  loadRepositoryConnection: vi.fn(),
  getConnectionRepository: vi.fn(),
}));

vi.mock("@/lib/integrations/repositories", () => ({
  loadRepositoryConnection: mocks.loadRepositoryConnection,
  getConnectionRepository: mocks.getConnectionRepository,
}));

vi.mock("@repo/database", () => {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      const value = row[key as keyof Row];
      if (expected && typeof expected === "object" && "not" in expected) {
        return value !== (expected as { not: unknown }).not;
      }
      return value === expected;
    });
  const withConnection = (row: Row) => ({
    ...row,
    connection: row.connectionId ? { name: "Contoso GitHub" } : null,
  });
  const sorted = (rows: Row[]) =>
    [...rows].sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.createdAt.getTime() - b.createdAt.getTime()
    );
  const db = {
    project: {
      findFirst: vi.fn(
        ({ where }: { where: { id: string; organizationId: string } }) =>
          Promise.resolve(
            mocks.projects.has(`${where.organizationId}:${where.id}`)
              ? { id: where.id }
              : null
          )
      ),
    },
    projectRepository: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          sorted(mocks.rows.filter((row) => matches(row, where))).map(
            withConnection
          )
        )
      ),
      findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        const [row] = [...mocks.rows]
          .filter((candidate) => matches(candidate, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return Promise.resolve(row ? withConnection(row) : null);
      }),
      create: vi.fn(
        ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
          mocks.sequence += 1;
          const at = new Date(Date.UTC(2026, 9, 5, 10, 0, mocks.sequence));
          const row: Row = {
            ...data,
            id: `repo-${mocks.sequence}`,
            createdAt: at,
            updatedAt: at,
          };
          mocks.rows.push(row);
          return Promise.resolve(withConnection(row));
        }
      ),
      update: vi.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = mocks.rows.find((candidate) => candidate.id === where.id);
          if (!row) {
            throw new Error("not found");
          }
          Object.assign(row, data);
          return Promise.resolve(withConnection(row));
        }
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<Row>;
        }) => {
          const targets = mocks.rows.filter((row) => matches(row, where));
          for (const row of targets) {
            Object.assign(row, data);
          }
          return Promise.resolve({ count: targets.length });
        }
      ),
      delete: vi.fn(({ where }: { where: { id: string } }) => {
        mocks.rows = mocks.rows.filter((row) => row.id !== where.id);
        return Promise.resolve({});
      }),
    },
    $executeRaw: vi.fn((_strings: TemplateStringsArray, key: string) => {
      mocks.locks.push(key);
      return Promise.resolve(1);
    }),
  };
  const withDb = (fn: (client: typeof db) => unknown) => fn(db);
  withDb.tx = (fn: (client: typeof db) => unknown) => fn(db);
  return { withDb };
});

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

const api: RepositoryInfo = {
  ...shop,
  externalId: "1296270",
  fullName: "contoso/api",
  name: "api",
  webUrl: "https://github.com/contoso/api",
  cloneUrl: "https://github.com/contoso/api.git",
};

function connectionFor(provider = "github") {
  return {
    ok: true,
    value: {
      loaded: {
        record: { id: IDS.connection, provider, name: "Contoso GitHub" },
      },
    },
  };
}

function addRepository(repository: RepositoryInfo, isPrimary?: boolean) {
  mocks.getConnectionRepository.mockResolvedValueOnce({
    ok: true,
    value: repository,
  });
  return projectRepositoryService.add(IDS.org, IDS.project, IDS.user, {
    connectionId: IDS.connection,
    externalId: repository.externalId,
    isPrimary,
  });
}

beforeEach(() => {
  mocks.rows = [];
  mocks.projects = new Set([`${IDS.org}:${IDS.project}`]);
  mocks.locks = [];
  mocks.sequence = 0;
  mocks.loadRepositoryConnection.mockReset();
  mocks.loadRepositoryConnection.mockResolvedValue(connectionFor());
  mocks.getConnectionRepository.mockReset();
});

describe("projectRepositoryService.add", () => {
  it("records the repository the connection resolves and makes the first one primary", async () => {
    const result = await addRepository(shop);

    expect(result).toEqual({
      ok: true,
      value: {
        id: "repo-1",
        projectId: IDS.project,
        connectionId: IDS.connection,
        connectionName: "Contoso GitHub",
        provider: "github",
        externalId: shop.externalId,
        fullName: "contoso/shop",
        name: "shop",
        defaultBranch: "main",
        webUrl: shop.webUrl,
        isPrimary: true,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    expect(mocks.rows[0]).toMatchObject({
      organizationId: IDS.org,
      cloneUrl: shop.cloneUrl,
      createdById: IDS.user,
    });
    expect(mocks.loadRepositoryConnection).toHaveBeenCalledWith(
      IDS.org,
      IDS.connection
    );
    expect(mocks.locks).toEqual([`project-repositories:${IDS.project}`]);
  });

  it("keeps the primary repository unless the new one asks to be primary", async () => {
    await addRepository(shop);
    const second = await addRepository(api);
    const third = await addRepository(
      { ...api, externalId: "1296271", fullName: "contoso/web" },
      true
    );

    expect(second.ok && second.value.isPrimary).toBe(false);
    expect(third.ok && third.value.isPrimary).toBe(true);
    expect(mocks.rows.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  it("refuses a repository the project already has", async () => {
    await addRepository(shop);

    const result = await addRepository(shop);

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.Conflict,
        message: "contoso/shop is already a repository of this project",
      },
    });
    expect(mocks.rows).toHaveLength(1);
  });

  it(`refuses more than ${PROJECT_REPOSITORIES_MAX} repositories`, async () => {
    for (let index = 0; index < PROJECT_REPOSITORIES_MAX; index += 1) {
      await addRepository({
        ...shop,
        externalId: String(index),
        fullName: `contoso/r${index}`,
      });
    }

    const result = await addRepository(api);

    expect(result.ok ? null : result.error.status).toBe(Status.Conflict);
    expect(mocks.rows).toHaveLength(PROJECT_REPOSITORIES_MAX);
  });

  it("passes connection and provider errors through", async () => {
    mocks.loadRepositoryConnection.mockResolvedValueOnce({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: "Microsoft Teams connections do not offer repositories",
      },
    });
    const unsupported = await projectRepositoryService.add(
      IDS.org,
      IDS.project,
      IDS.user,
      { connectionId: IDS.connection, externalId: "1" }
    );
    mocks.getConnectionRepository.mockResolvedValueOnce({
      ok: false,
      error: { status: Status.NotFound, message: "Repository not found" },
    });
    const missing = await projectRepositoryService.add(
      IDS.org,
      IDS.project,
      IDS.user,
      { connectionId: IDS.connection, externalId: "1" }
    );

    expect(unsupported.ok ? null : unsupported.error.status).toBe(
      Status.BadRequest
    );
    expect(missing.ok ? null : missing.error.status).toBe(Status.NotFound);
    expect(mocks.rows).toEqual([]);
  });

  it("returns not found for a project of another organization", async () => {
    const result = await projectRepositoryService.add(
      IDS.otherOrg,
      IDS.project,
      IDS.user,
      { connectionId: IDS.connection, externalId: shop.externalId }
    );

    expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
    expect(mocks.loadRepositoryConnection).not.toHaveBeenCalled();
  });
});

describe("projectRepositoryService.list / setPrimary / remove", () => {
  it("lists the primary repository first and null for an unknown project", async () => {
    await addRepository(shop);
    await addRepository(api, true);

    const repositories = await projectRepositoryService.list(
      IDS.org,
      IDS.project
    );

    expect(repositories?.map((repository) => repository.fullName)).toEqual([
      "contoso/api",
      "contoso/shop",
    ]);
    await expect(
      projectRepositoryService.list(IDS.otherOrg, IDS.project)
    ).resolves.toBeNull();
  });

  it("moves the primary flag", async () => {
    await addRepository(shop);
    await addRepository(api);

    const result = await projectRepositoryService.setPrimary(
      IDS.org,
      IDS.project,
      "repo-2"
    );

    expect(result.ok && result.value.isPrimary).toBe(true);
    expect(mocks.rows.map((row) => [row.fullName, row.isPrimary])).toEqual([
      ["contoso/shop", false],
      ["contoso/api", true],
    ]);
  });

  it("promotes the oldest remaining repository when the primary one is removed", async () => {
    await addRepository(shop);
    await addRepository(api);
    await addRepository({ ...api, externalId: "3", fullName: "contoso/web" });

    const result = await projectRepositoryService.remove(
      IDS.org,
      IDS.project,
      "repo-1"
    );

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(mocks.rows.map((row) => [row.fullName, row.isPrimary])).toEqual([
      ["contoso/api", true],
      ["contoso/web", false],
    ]);
  });

  it("returns not found for a repository of another project or organization", async () => {
    await addRepository(shop);

    const update = await projectRepositoryService.setPrimary(
      IDS.otherOrg,
      IDS.project,
      "repo-1"
    );
    const removal = await projectRepositoryService.remove(
      IDS.org,
      "0199a5f0-0000-7000-8000-0000000000d2",
      "repo-1"
    );

    expect(update.ok ? null : update.error.status).toBe(Status.NotFound);
    expect(removal.ok ? null : removal.error.status).toBe(Status.NotFound);
    expect(mocks.rows).toHaveLength(1);
  });
});
