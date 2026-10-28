import { LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachPullRequestsToRunSessions,
  type RunSessionPullRequest,
  withPullRequests,
} from "@/lib/workflows/engine/run-session-pull-requests";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  run: "0199a5f0-0000-7000-8000-0000000000c1",
  execute: "0199a5f0-0000-7000-8000-0000000000e1",
  step: "0199a5f0-0000-7000-8000-0000000000e2",
  executeSession: "0199a5f0-0000-7000-8000-0000000000a1",
  stepSession: "0199a5f0-0000-7000-8000-0000000000a2",
  otherBranchSession: "0199a5f0-0000-7000-8000-0000000000a3",
};

const PR_URL = "http://localhost:3300/workshop/calculator-app/pulls/2";

const OPENED: RunSessionPullRequest = {
  repository: "workshop/calculator-app",
  branch: "symphony/pln-2",
  url: PR_URL,
  number: 2,
  title: "CALC-2: Add an MIT license",
};

type SessionRow = {
  artifactId: string;
  branch: string | null;
  repositoryFullName: string | null;
  pullRequests: unknown;
};

const mocks = vi.hoisted(() => ({
  loopQueries: [] as unknown[],
  sessionQueries: [] as unknown[],
  sessions: [] as SessionRow[],
  updates: [] as Array<{ where: unknown; data: unknown }>,
  locks: 0,
  failLoops: false,
  warnings: [] as string[],
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn((message: string) => {
      mocks.warnings.push(message);
    }),
  },
}));

vi.mock("@repo/database", () => {
  const db = {
    workflowRunLoop: {
      findMany: vi.fn((args: unknown) => {
        mocks.loopQueries.push(args);
        if (mocks.failLoops) {
          return Promise.reject(new Error("connection reset"));
        }
        return Promise.resolve([{ loopId: IDS.execute }, { loopId: IDS.step }]);
      }),
    },
    sessionDetail: {
      findMany: vi.fn((args: unknown) => {
        mocks.sessionQueries.push(args);
        return Promise.resolve(mocks.sessions);
      }),
      update: vi.fn((args: { where: unknown; data: unknown }) => {
        mocks.updates.push(args);
        return Promise.resolve({});
      }),
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
    Prisma: { sql: () => "locked", join: (values: unknown[]) => values },
  };
});

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    artifactId: IDS.executeSession,
    branch: "symphony/pln-2",
    repositoryFullName: "workshop/calculator-app",
    pullRequests: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.loopQueries = [];
  mocks.sessionQueries = [];
  mocks.sessions = [];
  mocks.updates = [];
  mocks.locks = 0;
  mocks.failLoops = false;
  mocks.warnings = [];
});

describe("attachPullRequestsToRunSessions", () => {
  it("lists the pull request, with its page, on the sessions that worked on its branch", async () => {
    mocks.sessions = [
      session(),
      session({ artifactId: IDS.stepSession }),
      session({ artifactId: IDS.otherBranchSession, branch: "symphony/pln-9" }),
    ];

    await attachPullRequestsToRunSessions({
      runId: IDS.run,
      organizationId: IDS.org,
      pullRequests: [OPENED],
    });

    // Plan loops never change the code.
    expect(mocks.loopQueries).toEqual([
      {
        where: {
          runId: IDS.run,
          organizationId: IDS.org,
          command: { not: LoopCommand.Plan },
        },
        select: { loopId: true },
      },
    ]);
    expect(mocks.sessionQueries).toEqual([
      expect.objectContaining({
        where: {
          sourceLoopId: { in: [IDS.execute, IDS.step] },
          artifact: { organizationId: IDS.org },
        },
      }),
    ]);
    expect(mocks.locks).toBe(1);
    const listed = [
      {
        num: 2,
        title: "CALC-2: Add an MIT license",
        status: "open",
        url: PR_URL,
      },
    ];
    expect(mocks.updates).toEqual([
      {
        where: { artifactId: IDS.executeSession },
        data: { pullRequests: listed },
      },
      {
        where: { artifactId: IDS.stepSession },
        data: { pullRequests: listed },
      },
    ]);
  });

  it("leaves a session of another repository alone", async () => {
    mocks.sessions = [
      session({ repositoryFullName: "workshop/website" }),
      session({ artifactId: IDS.stepSession, repositoryFullName: null }),
    ];

    await attachPullRequestsToRunSessions({
      runId: IDS.run,
      organizationId: IDS.org,
      pullRequests: [OPENED],
    });

    expect(mocks.updates).toEqual([]);
  });

  it("does nothing without pull requests", async () => {
    await attachPullRequestsToRunSessions({
      runId: IDS.run,
      organizationId: IDS.org,
      pullRequests: [],
    });

    expect(mocks.loopQueries).toEqual([]);
  });

  it("never fails the action that opened the pull request", async () => {
    mocks.failLoops = true;

    await expect(
      attachPullRequestsToRunSessions({
        runId: IDS.run,
        organizationId: IDS.org,
        pullRequests: [OPENED],
      })
    ).resolves.toBeUndefined();
    expect(mocks.updates).toEqual([]);
    expect(mocks.warnings).toHaveLength(1);
  });
});

describe("withPullRequests", () => {
  it("replaces the entry of the same number and keeps the others", () => {
    const stored = [
      { num: 1, title: "CALC-1: Add a contributing guide", status: "open" },
      { num: "2", title: "Earlier title", status: "unknown" },
    ];

    expect(withPullRequests(stored, [OPENED])).toEqual([
      { num: 1, title: "CALC-1: Add a contributing guide", status: "open" },
      {
        num: 2,
        title: "CALC-2: Add an MIT license",
        status: "open",
        url: PR_URL,
      },
    ]);
  });

  it("names a pull request without a title by its number", () => {
    expect(withPullRequests(null, [{ ...OPENED, title: "  " }])[0]?.title).toBe(
      "PR #2"
    );
  });

  it("drops a stored list the read side could not show, and a page that is not http(s)", () => {
    expect(withPullRequests([{ num: 7 }], [OPENED])).toEqual([
      expect.objectContaining({ num: 2 }),
    ]);
    expect(
      withPullRequests(null, [{ ...OPENED, url: "javascript:alert(1)" }])
    ).toEqual([]);
  });
});
