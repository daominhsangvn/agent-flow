import { IntegrationConnectionStatus } from "@repo/api/src/types/integration";
import { WORKFLOW_INSTRUCTION_ACTION_TYPE } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveActionConnection } from "@/lib/workflows/engine/action-connection";

/**
 * The connections an action works through: the built-in HTTPS call's own
 * connection; a project connection named by key (an action on the source item
 * only for runs from that connection, never re-routed); without a key the
 * run's source for instructions and source item actions, the repositories'
 * connections for pull requests, else the project's only connection that
 * offers the type.
 */

type ProjectConnectionRow = {
  id: string;
  projectId: string;
  key: string;
  provider: string;
};

const mocks = vi.hoisted(() => ({
  run: null as {
    connectionId: string | null;
    projectId: string;
    projectConnectionId: string | null;
    repository: unknown;
  } | null,
  projectConnections: [] as ProjectConnectionRow[],
  checkouts: [] as Array<{ connectionId: string; provider: string }>,
  loadConnectionRuntime: vi.fn(),
  loadProjectConnectionRuntime: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      workflowRun: { findFirst: () => Promise.resolve(mocks.run) },
      projectConnection: {
        findFirst: (args: {
          where: { id?: string; projectId?: string; key?: string };
        }) =>
          Promise.resolve(
            toRow(
              mocks.projectConnections.find(
                (row) =>
                  (args.where.id === undefined || row.id === args.where.id) &&
                  (args.where.projectId === undefined ||
                    row.projectId === args.where.projectId) &&
                  (args.where.key === undefined || row.key === args.where.key)
              )
            )
          ),
        findMany: (args: { where: { projectId: string } }) =>
          Promise.resolve(
            mocks.projectConnections
              .filter((row) => row.projectId === args.where.projectId)
              .map(toRow)
          ),
      },
    }),
}));
vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listProjectRepositoryCheckouts: () => Promise.resolve(mocks.checkouts),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
}));
vi.mock("@/lib/integrations/project-connections", () => ({
  loadProjectConnectionRuntime: mocks.loadProjectConnectionRuntime,
}));
vi.mock("@/lib/integrations/registry", () => ({
  findActionDefinition: (provider: string, type: string) => {
    if (!type.startsWith(`${provider}.`)) {
      return null;
    }
    return {
      key: type,
      repositoryScoped: type.endsWith(".create_pull_request"),
      sourceOperation: type.endsWith(".comment") ? "comment" : undefined,
    };
  },
  isRepositoryScopedActionType: (type: string) =>
    type.endsWith(".create_pull_request"),
}));

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run = {
    connectionId: "conn-jira",
    projectId: PROJECT_ID,
    projectConnectionId: "pc-jira-1",
    repository: null,
  };
  mocks.projectConnections = [
    { id: "pc-jira-1", projectId: PROJECT_ID, key: "jira-1", provider: "jira" },
    { id: "pc-jira-2", projectId: PROJECT_ID, key: "jira-2", provider: "jira" },
    {
      id: "pc-teams",
      projectId: PROJECT_ID,
      key: "teams-release",
      provider: "teams",
    },
  ];
  mocks.checkouts = [
    { connectionId: "conn-git", provider: "git" },
    { connectionId: "conn-git", provider: "git" },
  ];
  mocks.loadConnectionRuntime.mockImplementation((_org: string, id: string) =>
    Promise.resolve(loaded(id, IntegrationConnectionStatus.Active))
  );
  mocks.loadProjectConnectionRuntime.mockImplementation(
    (_org: string, id: string) =>
      Promise.resolve({
        record: { id },
        connection: loaded(id, IntegrationConnectionStatus.Active),
        settings: {},
      })
  );
});

describe("resolveActionConnection", () => {
  it("uses the built-in HTTPS call's own connection", async () => {
    const result = await resolve({ connectionId: "conn-http", type: "x.post" });

    expect(ids(result)).toEqual(["conn-http"]);
  });

  it("works an instruction on the run's source project connection", async () => {
    const result = await resolve({ type: WORKFLOW_INSTRUCTION_ACTION_TYPE });

    expect(ids(result)).toEqual(["pc-jira-1"]);
  });

  it("works on the trigger's own connection for a run of the built-in HTTP endpoint", async () => {
    mocks.run = {
      ...run(),
      projectConnectionId: null,
      connectionId: "conn-http",
    };

    const result = await resolve({ type: WORKFLOW_INSTRUCTION_ACTION_TYPE });

    expect(ids(result)).toEqual(["conn-http"]);
  });

  it("skips an instruction of a run no trigger started", async () => {
    mocks.run = { ...run(), projectConnectionId: null, connectionId: null };

    const result = await resolve({ type: WORKFLOW_INSTRUCTION_ACTION_TYPE });

    expect(result.ok).toBe(false);
  });

  it("works a keyed external action on that project connection", async () => {
    const result = await resolve({
      connectionKey: "teams-release",
      type: "teams.post",
    });

    expect(ids(result)).toEqual(["pc-teams"]);
  });

  it("runs a keyed source item action for runs from that connection", async () => {
    const result = await resolve({
      connectionKey: "jira-1",
      type: "jira.comment",
    });

    expect(ids(result)).toEqual(["pc-jira-1"]);
  });

  it("never re-routes a source item action to another connection", async () => {
    const result = await resolve({
      connectionKey: "jira-2",
      type: "jira.comment",
    });

    expect(result).toEqual({
      ok: false,
      reason:
        'This action works on the source item of runs from "jira-2"; this run came from another connection.',
    });
    expect(mocks.loadProjectConnectionRuntime).not.toHaveBeenCalled();
  });

  it("skips a key the run's project does not have", async () => {
    const result = await resolve({
      connectionKey: "jira-9",
      type: "jira.comment",
    });

    expect(result).toEqual({
      ok: false,
      reason: 'The run\'s project has no connection "jira-9".',
    });
  });

  it("pins a source item action without a key to the run's source", async () => {
    const result = await resolve({ type: "jira.comment" });

    expect(ids(result)).toEqual(["pc-jira-1"]);
  });

  it("uses the project's only connection that offers an external type", async () => {
    const result = await resolve({ type: "teams.post" });

    expect(ids(result)).toEqual(["pc-teams"]);
  });

  it("refuses to guess between several connections that offer the type", async () => {
    mocks.run = { ...run(), projectConnectionId: null, connectionId: null };

    const result = await resolve({ type: "jira.create_issue" });

    expect(result).toEqual({
      ok: false,
      reason:
        'Several connections of the run\'s project offer "jira.create_issue" (jira-1, jira-2). Name one for the action.',
    });
  });

  it("runs a pull request on every connection that owns one of the run's repositories", async () => {
    mocks.projectConnections.push({
      id: "pc-git",
      projectId: PROJECT_ID,
      key: "git",
      provider: "git",
    });
    mocks.checkouts = [
      { connectionId: "conn-git", provider: "git" },
      { connectionId: "conn-git-2", provider: "git" },
    ];
    mocks.run = {
      ...run(),
      repository: [
        repository("r1", "conn-git"),
        repository("r2", "conn-git-2"),
      ],
    };

    const result = await resolve({ type: "git.create_pull_request" });

    expect(ids(result)).toEqual(["conn-git", "conn-git-2"]);
  });

  it("runs a pull request on the repository's connection when the project has no connection of its provider", async () => {
    mocks.checkouts = [{ connectionId: "conn-local-git", provider: "git" }];
    mocks.run = { ...run(), repository: [repository("r1", "conn-local-git")] };

    const result = await resolve({ type: "git.create_pull_request" });

    expect(ids(result)).toEqual(["conn-local-git"]);
  });

  it("skips a pull request when no repository of the project is on a connection that offers it", async () => {
    mocks.checkouts = [];

    const result = await resolve({ type: "git.create_pull_request" });

    expect(result).toEqual({
      ok: false,
      reason:
        'No repository connection of the run\'s project offers "git.create_pull_request".',
    });
  });

  it("skips when the project connection cannot be loaded", async () => {
    mocks.loadProjectConnectionRuntime.mockResolvedValue(null);

    const result = await resolve({ type: WORKFLOW_INSTRUCTION_ACTION_TYPE });

    expect(result.ok).toBe(false);
  });

  it("skips when the organization connection is disabled", async () => {
    mocks.loadProjectConnectionRuntime.mockResolvedValue({
      record: { id: "pc-jira-1" },
      connection: loaded("pc-jira-1", IntegrationConnectionStatus.Disabled),
      settings: {},
    });

    const result = await resolve({ type: WORKFLOW_INSTRUCTION_ACTION_TYPE });

    expect(result).toEqual({
      ok: false,
      reason: 'The connection "Connection pc-jira-1" is disabled.',
    });
  });
});

function run() {
  if (!mocks.run) {
    throw new Error("run expected");
  }
  return mocks.run;
}

function resolve(action: {
  connectionId?: string | null;
  connectionKey?: string | null;
  type: string;
}) {
  return resolveActionConnection({
    organizationId: ORG_ID,
    runId: "run-1",
    action: {
      connectionId: action.connectionId ?? null,
      connectionKey: action.connectionKey ?? null,
      type: action.type,
    },
  });
}

function ids(result: Awaited<ReturnType<typeof resolve>>): string[] {
  return result.ok
    ? result.connections.map((connection) => connection.record.id)
    : [`skipped: ${result.reason}`];
}

function loaded(id: string, status: string) {
  return {
    record: { id, name: `Connection ${id}`, status },
    provider: {},
    runtime: {},
  };
}

function toRow(row: ProjectConnectionRow | undefined) {
  return row
    ? { id: row.id, key: row.key, connection: { provider: row.provider } }
    : null;
}

function repository(id: string, connectionId: string) {
  return {
    id,
    connectionId,
    provider: "git",
    externalId: id,
    fullName: `acme/${id}`,
    webUrl: `https://git.test/acme/${id}`,
    cloneUrl: `https://git.test/acme/${id}.git`,
    defaultBranch: "main",
    branch: null,
    baseBranch: "main",
    pullRequest: null,
  };
}
