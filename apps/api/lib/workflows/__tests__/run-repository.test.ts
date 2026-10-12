import type { RepoExecutionResult } from "@agentflow-ai/loops-api/execution-result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordActionOutputs,
  recordRunRepositories,
  recordRunRepositoryBranches,
} from "@/lib/workflows/engine/run-repository";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  run: "0199a5f0-0000-7000-8000-0000000000c1",
  project: "0199a5f0-0000-7000-8000-0000000000d1",
  connection: "0199a5f0-0000-7000-8000-0000000000e1",
  shop: "0199a5f0-0000-7000-8000-0000000000f1",
  api: "0199a5f0-0000-7000-8000-0000000000f2",
};

const DB_NULL = "__db_null__";

type Update = { where: Record<string, unknown>; data: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  projectId: null as string | null,
  projectRepositories: [] as Record<string, unknown>[],
  /** WorkflowRun.repository / prUrl as stored. */
  stored: null as unknown,
  prUrl: null as string | null,
  runUpdates: [] as Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>,
  locks: 0,
  failRunLookup: false,
}));

vi.mock("@repo/database", () => {
  const db = {
    workflowRun: {
      findFirst: vi.fn((args: { select: Record<string, unknown> }) => {
        if (mocks.failRunLookup) {
          return Promise.reject(new Error("connection reset"));
        }
        return Promise.resolve(
          "workflow" in args.select
            ? { workflow: { projectId: mocks.projectId } }
            : { repository: mocks.stored }
        );
      }),
      findUnique: vi.fn(() =>
        Promise.resolve({ repository: mocks.stored, prUrl: mocks.prUrl })
      ),
      updateMany: vi.fn((args: Update) => {
        mocks.runUpdates.push(args);
        return Promise.resolve({ count: 1 });
      }),
      update: vi.fn((args: Update) => {
        mocks.runUpdates.push(args);
        return Promise.resolve({});
      }),
    },
    projectRepository: {
      findMany: vi.fn(() => Promise.resolve(mocks.projectRepositories)),
    },
    $queryRaw: vi.fn(() => {
      mocks.locks += 1;
      return Promise.resolve([]);
    }),
  };
  const withDb = Object.assign((fn: (client: typeof db) => unknown) => fn(db), {
    tx: (fn: (client: typeof db) => unknown) => fn(db),
  });
  return {
    withDb,
    Prisma: { DbNull: "__db_null__", sql: () => "locked" },
  };
});

const SHOP_ROW = {
  id: IDS.shop,
  connectionId: IDS.connection,
  provider: "github",
  externalId: "1296269",
  fullName: "contoso/shop",
  webUrl: "https://github.com/contoso/shop",
  cloneUrl: "https://github.com/contoso/shop.git",
  defaultBranch: "main",
};

const API_ROW = {
  ...SHOP_ROW,
  id: IDS.api,
  externalId: "1296270",
  fullName: "contoso/api",
  webUrl: "https://github.com/contoso/api",
  cloneUrl: "https://github.com/contoso/api.git",
};

function snapshotOf(
  row: typeof SHOP_ROW,
  overrides: Record<string, unknown> = {}
) {
  return {
    ...row,
    branch: null,
    baseBranch: "main",
    pullRequest: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.projectId = IDS.project;
  mocks.projectRepositories = [
    SHOP_ROW,
    API_ROW,
    {
      ...SHOP_ROW,
      id: "unlinked",
      fullName: "contoso/docs",
      connectionId: null,
    },
  ];
  mocks.stored = null;
  mocks.prUrl = null;
  mocks.runUpdates = [];
  mocks.locks = 0;
  mocks.failRunLookup = false;
});

describe("recordRunRepositories", () => {
  it("stores every project repository the loop works in, in the loop's order", async () => {
    await recordRunRepositories({
      runId: IDS.run,
      organizationId: IDS.org,
      repos: [
        { fullName: "Contoso/API", baseBranch: "develop" },
        { fullName: "contoso/shop", baseBranch: "" },
        { fullName: "contoso/docs", baseBranch: "main" },
        { fullName: "contoso/unknown", baseBranch: "main" },
      ],
    });

    expect(mocks.runUpdates).toEqual([
      {
        where: { id: IDS.run, organizationId: IDS.org },
        data: {
          repository: [
            snapshotOf(API_ROW, { baseBranch: "develop" }),
            snapshotOf(SHOP_ROW),
          ],
        },
      },
    ]);
  });

  it("clears the repositories when the project has none of the loop's", async () => {
    await recordRunRepositories({
      runId: IDS.run,
      organizationId: IDS.org,
      repos: [{ fullName: "contoso/other", baseBranch: "main" }],
    });

    expect(mocks.runUpdates[0]?.data).toEqual({ repository: DB_NULL });
  });

  it("never throws", async () => {
    mocks.failRunLookup = true;

    await expect(
      recordRunRepositories({
        runId: IDS.run,
        organizationId: IDS.org,
        repos: [{ fullName: "contoso/shop", baseBranch: "main" }],
      })
    ).resolves.toBeUndefined();
    expect(mocks.runUpdates).toEqual([]);
  });
});

describe("recordRunRepositoryBranches", () => {
  it("sets the branch of each pushed repository and none for the unchanged ones", async () => {
    mocks.stored = [snapshotOf(SHOP_ROW), snapshotOf(API_ROW)];
    const results: RepoExecutionResult[] = [
      { status: "skipped", fullName: "contoso/shop", reason: "no_changes" },
      {
        status: "pushed",
        fullName: "Contoso/Api",
        branchName: "feat/iss-7",
        baseBranch: "develop",
      },
    ];

    await recordRunRepositoryBranches(IDS.run, IDS.org, results);

    expect(mocks.runUpdates).toEqual([
      {
        where: { id: IDS.run, organizationId: IDS.org },
        data: {
          repository: [
            snapshotOf(SHOP_ROW),
            snapshotOf(API_ROW, {
              branch: "feat/iss-7",
              baseBranch: "develop",
            }),
          ],
        },
      },
    ]);
  });

  it("does nothing without results or recorded repositories", async () => {
    await recordRunRepositoryBranches(IDS.run, IDS.org, []);
    await recordRunRepositoryBranches(IDS.run, IDS.org, [
      { status: "skipped", fullName: "contoso/shop", reason: "no_changes" },
    ]);

    expect(mocks.runUpdates).toEqual([]);
  });
});

describe("recordActionOutputs", () => {
  const opened = {
    pullRequests: [
      {
        repositoryId: IDS.api,
        url: "https://github.com/contoso/api/pull/42",
        number: 42,
        branch: "feat/iss-7",
      },
    ],
  };

  it("records each pull request on its repository and the first on the run", async () => {
    mocks.stored = [
      snapshotOf(SHOP_ROW),
      snapshotOf(API_ROW, { branch: "feat/iss-7" }),
    ];

    await recordActionOutputs(IDS.run, opened);
    await recordActionOutputs(IDS.run, undefined);
    await recordActionOutputs(IDS.run, { pullRequests: [] });

    expect(mocks.locks).toBe(1);
    expect(mocks.runUpdates).toEqual([
      {
        where: { id: IDS.run },
        data: {
          repository: [
            snapshotOf(SHOP_ROW),
            snapshotOf(API_ROW, {
              branch: "feat/iss-7",
              pullRequest: {
                url: "https://github.com/contoso/api/pull/42",
                number: 42,
              },
            }),
          ],
          prUrl: "https://github.com/contoso/api/pull/42",
          branchName: "feat/iss-7",
        },
      },
    ]);
  });

  it("keeps the run's pull request when it already has one", async () => {
    mocks.stored = [snapshotOf(API_ROW, { branch: "feat/iss-7" })];
    mocks.prUrl = "https://github.com/contoso/shop/pull/1";

    await recordActionOutputs(IDS.run, opened);

    expect(mocks.runUpdates[0]?.data).not.toHaveProperty("prUrl");
  });
});
