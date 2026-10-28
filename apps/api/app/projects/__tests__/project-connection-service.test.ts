import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { projectConnectionDbFake } from "@/__tests__/support/projects/project-connection-db.test-fake";
import { projectConnectionService } from "@/app/projects/project-connection-service";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import { defineIntegrationProvider } from "@/lib/integrations/types";

const mocks = vi.hoisted(() => ({
  loadConnectionRuntime: vi.fn(),
  currentProcess: { kind: "none" } as Record<string, unknown>,
}));

vi.mock("@repo/database", async () => {
  const fake = await import(
    "@/__tests__/support/projects/project-connection-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) =>
    fn(fake.projectConnectionDbFake.db);
  withDb.tx = (fn: (tx: unknown) => unknown) =>
    fn(fake.projectConnectionDbFake.db);
  return { withDb, Prisma: { DbNull: fake.PRISMA_DB_NULL } };
});
vi.mock("@/app/projects/project-process-service", () => ({
  CurrentProcessKind: { None: "none", Found: "found" },
  projectProcessService: {
    findCurrent: () => Promise.resolve(mocks.currentProcess),
  },
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const OTHER_PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d2";
const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const QC_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e3";
const TEAMS_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e2";
const USER_ID = "0199a5f0-0000-7000-8000-0000000000a1";
const SITE_URL = "https://acme.example.test";
const PROJECT_LOCK = `project-connections:${ORG_ID}`;

const trackerProvider = defineIntegrationProvider({
  key: "tracker",
  displayName: "Tracker",
  description: "Test tracker",
  connection: {
    configSchema: z.object({ siteUrl: z.string() }),
    secretsSchema: z.object({ apiToken: z.string().min(1) }),
    fields: [
      { key: "siteUrl", label: "Site URL", kind: IntegrationFieldKind.Url },
    ],
    validate: () => Promise.resolve({ ok: true, account: null }),
  },
  project: {
    settingsSchema: z.object({
      keys: z.array(z.string().toUpperCase()).min(1, "Enter a key"),
    }),
    settingsFields: [],
    containers: (settings: { keys: string[] }) => settings.keys,
    normalizeContainer: (container: string) => container.toUpperCase(),
    origin: (config: { siteUrl: string }) => config.siteUrl,
    triggerContainersField: "keys",
  },
  triggers: [],
  actions: [],
});

const teamsProvider = defineIntegrationProvider({
  key: "teams",
  displayName: "Teams",
  description: "Test channel",
  connection: {
    configSchema: z.object({}),
    secretsSchema: z.object({ url: z.string() }),
    fields: [],
    validate: () => Promise.resolve({ ok: true, account: null }),
  },
  triggers: [],
  actions: [],
});

const CONNECTION_NAMES: Record<string, string> = {
  [CONNECTION_ID]: "Tracker · Dev bot",
  [QC_CONNECTION_ID]: "Tracker · QC bot",
  [TEAMS_CONNECTION_ID]: "Release channel",
};

beforeEach(() => {
  vi.clearAllMocks();
  projectConnectionDbFake.reset();
  projectConnectionDbFake.addProject({
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Billing",
  });
  projectConnectionDbFake.addProject({
    id: OTHER_PROJECT_ID,
    organizationId: ORG_ID,
    name: "Payments",
  });
  for (const id of [CONNECTION_ID, QC_CONNECTION_ID, TEAMS_CONNECTION_ID]) {
    projectConnectionDbFake.addConnection({
      id,
      organizationId: ORG_ID,
      name: CONNECTION_NAMES[id] as string,
      provider:
        id === TEAMS_CONNECTION_ID ? teamsProvider.key : trackerProvider.key,
    });
  }
  mocks.loadConnectionRuntime.mockImplementation(
    (_organizationId: string, connectionId: string) =>
      Promise.resolve(loadedConnection(connectionId))
  );
});

describe("projectConnectionService.add", () => {
  it("adds the connection under its key and claims the settings' source items", async () => {
    const result = await addTracker({ key: "tracker-dev", keys: ["ab"] });

    expect(result.ok ? result.value : result.error).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        connectionId: CONNECTION_ID,
        connectionName: "Tracker · Dev bot",
        provider: trackerProvider.key,
        key: "tracker-dev",
        name: "Tracker dev",
        settings: { keys: ["AB"] },
      }),
    ]);
    expect(scopeKeys()).toEqual([`tracker:${SITE_URL}:AB`]);
    expect(projectConnectionDbFake.locks).toEqual([PROJECT_LOCK]);
  });

  it("adds several connections of one integration (one bot each) with the same settings", async () => {
    const result = await projectConnectionService.add(
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      {
        connections: [
          { connectionId: CONNECTION_ID, key: "jira-dev", name: "Dev" },
          { connectionId: QC_CONNECTION_ID, key: "jira-qc", name: "QC" },
        ],
        settings: { keys: ["ab"] },
      }
    );

    expect(
      result.ok ? result.value.map((row) => [row.key, row.connectionId]) : null
    ).toEqual([
      ["jira-dev", CONNECTION_ID],
      ["jira-qc", QC_CONNECTION_ID],
    ]);
    expect(scopeKeys()).toEqual([
      `tracker:${SITE_URL}:AB`,
      `tracker:${SITE_URL}:AB`,
    ]);
  });

  it("lets the project's connections share source items added one at a time", async () => {
    await addTracker({ key: "tracker-dev", keys: ["AB"] });

    const result = await addTracker({
      key: "tracker-qc",
      keys: ["ab"],
      connectionId: QC_CONNECTION_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("adds a connection without project settings with no claims", async () => {
    const result = await projectConnectionService.add(
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      {
        connections: [
          {
            connectionId: TEAMS_CONNECTION_ID,
            key: "teams-release",
            name: "Release channel",
          },
        ],
        settings: { ignored: true },
      }
    );

    expect(result.ok ? result.value[0]?.settings : result.error).toEqual({});
    expect(scopeKeys()).toEqual([]);
  });

  it("returns 404 for a project of another organization", async () => {
    const result = await projectConnectionService.add(
      "0199a5f0-0000-7000-8000-00000000000b",
      PROJECT_ID,
      USER_ID,
      trackerInput({ key: "tracker", keys: ["AB"] })
    );

    expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
  });

  it("refuses a connection that cannot be loaded or belongs to a workflow", async () => {
    mocks.loadConnectionRuntime.mockResolvedValueOnce(null);
    const missing = await addTracker({ key: "tracker", keys: ["AB"] });

    const managed = loadedConnection(CONNECTION_ID);
    mocks.loadConnectionRuntime.mockResolvedValueOnce({
      ...managed,
      record: { ...managed.record, managedByWorkflowId: "workflow-1" },
    });
    const workflowOwned = await addTracker({ key: "tracker", keys: ["AB"] });

    expect(missing.ok ? null : missing.error.status).toBe(Status.BadRequest);
    expect(workflowOwned.ok ? null : workflowOwned.error.message).toBe(
      "Tracker connections cannot be added to a project."
    );
    expect(projectConnectionDbFake.projectConnections.size).toBe(0);
  });

  it("refuses connections of several integrations in one request", async () => {
    const result = await projectConnectionService.add(
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      {
        connections: [
          { connectionId: CONNECTION_ID, key: "tracker", name: "Tracker" },
          { connectionId: TEAMS_CONNECTION_ID, key: "teams", name: "Teams" },
        ],
        settings: { keys: ["AB"] },
      }
    );

    expect(result.ok ? null : result.error).toEqual({
      status: Status.BadRequest,
      message:
        "Add connections of one integration at a time: they share the project settings.",
    });
    expect(projectConnectionDbFake.projectConnections.size).toBe(0);
  });

  it("refuses settings the provider does not accept", async () => {
    const result = await addTracker({ key: "tracker", keys: [] });

    expect(result.ok ? null : result.error).toEqual({
      status: Status.BadRequest,
      message: "Invalid project settings: keys: Enter a key",
    });
  });

  it("refuses a key already used in the project", async () => {
    await addTracker({ key: "tracker", keys: ["AB"] });

    const result = await addTracker({
      key: "tracker",
      keys: ["CD"],
      connectionId: QC_CONNECTION_ID,
    });

    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      message: 'The key "tracker" is already used in this project.',
    });
  });

  it("refuses the same connection twice in a project", async () => {
    await addTracker({ key: "tracker", keys: ["AB"] });

    const result = await addTracker({ key: "tracker-two", keys: ["CD"] });

    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      message:
        'This connection is already in the project as "tracker". A connection is one account: for another bot, add a connection for it in Settings → Integrations.',
    });
  });

  it("adds none of the connections when one conflicts", async () => {
    await addTracker({
      key: "jira-qc",
      keys: ["ZZ"],
      connectionId: QC_CONNECTION_ID,
    });

    const result = await projectConnectionService.add(
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      {
        connections: [
          { connectionId: CONNECTION_ID, key: "jira-dev", name: "Dev" },
          { connectionId: QC_CONNECTION_ID, key: "jira-qc-2", name: "QC" },
        ],
        settings: { keys: ["AB"] },
      }
    );

    expect(result.ok ? null : result.error.status).toBe(Status.Conflict);
    expect(
      [...projectConnectionDbFake.projectConnections.values()].map(
        (row) => row.key
      )
    ).toEqual(["jira-qc"]);
  });

  it("refuses source items a project connection of another project claims", async () => {
    await addTracker({
      key: "tracker",
      keys: ["AB"],
      projectId: OTHER_PROJECT_ID,
    });

    const result = await addTracker({
      key: "tracker",
      keys: ["xy", "ab"],
      connectionId: QC_CONNECTION_ID,
    });

    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      message:
        'AB already belongs to "tracker" in project Payments. Remove it there first.',
    });
    expect(projectConnectionDbFake.projectConnections.size).toBe(1);
  });
});

describe("projectConnectionService.update", () => {
  it("replaces the claims when the settings change", async () => {
    const id = await addedId({ key: "tracker", keys: ["AB"] });

    const result = await projectConnectionService.update(
      ORG_ID,
      PROJECT_ID,
      id,
      { name: "Tracker", settings: { keys: ["AB", "CD"] } }
    );

    expect(result.ok ? result.value : result.error).toMatchObject({
      key: "tracker",
      name: "Tracker",
      settings: { keys: ["AB", "CD"] },
    });
    expect(scopeKeys()).toEqual([
      `tracker:${SITE_URL}:AB`,
      `tracker:${SITE_URL}:CD`,
    ]);
  });

  it("refuses settings that claim another project's source items", async () => {
    await addTracker({
      key: "tracker",
      keys: ["PAY"],
      projectId: OTHER_PROJECT_ID,
    });
    const id = await addedId({
      key: "tracker",
      keys: ["AB"],
      connectionId: QC_CONNECTION_ID,
    });

    const result = await projectConnectionService.update(
      ORG_ID,
      PROJECT_ID,
      id,
      { settings: { keys: ["AB", "PAY"] } }
    );

    expect(result.ok ? null : result.error.status).toBe(Status.Conflict);
  });

  it("returns 404 for a project connection of another project", async () => {
    const id = await addedId({ key: "tracker", keys: ["AB"] });

    const result = await projectConnectionService.update(
      ORG_ID,
      OTHER_PROJECT_ID,
      id,
      { name: "Moved" }
    );

    expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
  });
});

describe("projectConnectionService.remove / listForConnection", () => {
  it("refuses to remove a project connection a workflow or the process uses", async () => {
    const id = await addedId({ key: "tracker", keys: ["AB"] });
    projectConnectionDbFake.workflows.push({
      name: "Tracker to PR",
      agentConfig: {},
      triggers: [],
      actions: [
        { connectionKey: null, config: { connections: { tracker: "read" } } },
      ],
    });
    mocks.currentProcess = {
      kind: "found",
      snapshot: {
        definition: {
          steps: [
            { type: "agent", id: "read", connections: { tracker: "read" } },
          ],
        },
      },
    };

    const result = await projectConnectionService.remove(
      ORG_ID,
      PROJECT_ID,
      id
    );

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.Conflict,
        message:
          '"tracker" is used by workflow "Tracker to PR", the project\'s process. Remove it there first.',
      },
    });
    mocks.currentProcess = { kind: "none" };
  });

  it("removes the project connection and frees its claims", async () => {
    const id = await addedId({ key: "tracker", keys: ["AB"] });

    const result = await projectConnectionService.remove(
      ORG_ID,
      PROJECT_ID,
      id
    );
    const again = await addTracker({
      key: "tracker",
      keys: ["AB"],
      projectId: OTHER_PROJECT_ID,
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(again.ok).toBe(true);
  });

  it("lists the projects that use a connection", async () => {
    await addTracker({ key: "tracker", keys: ["AB"] });
    await addTracker({
      key: "tracker-payments",
      keys: ["PAY"],
      projectId: OTHER_PROJECT_ID,
    });

    const projects = await projectConnectionService.listForConnection(
      ORG_ID,
      CONNECTION_ID
    );

    expect(projects).toEqual([
      expect.objectContaining({ projectName: "Billing", key: "tracker" }),
      expect.objectContaining({
        projectName: "Payments",
        key: "tracker-payments",
      }),
    ]);
  });
});

function loadedConnection(connectionId: string): LoadedConnection {
  const isTeams = connectionId === TEAMS_CONNECTION_ID;
  const provider = isTeams ? teamsProvider : trackerProvider;
  return {
    record: {
      id: connectionId,
      organizationId: ORG_ID,
      provider: provider.key,
      managedByWorkflowId: null,
    },
    provider,
    runtime: {
      id: connectionId,
      organizationId: ORG_ID,
      provider: provider.key,
      name: CONNECTION_NAMES[connectionId],
      config: isTeams ? {} : { siteUrl: SITE_URL },
      secrets: isTeams ? { url: "https://hook.test" } : { apiToken: "t" },
      account: null,
    },
  } as unknown as LoadedConnection;
}

type TrackerEntry = {
  key: string;
  keys: string[];
  connectionId?: string;
  projectId?: string;
};

function trackerInput(input: TrackerEntry) {
  return {
    connections: [
      {
        connectionId: input.connectionId ?? CONNECTION_ID,
        key: input.key,
        name: `Tracker ${input.key.slice("tracker-".length)}`.trim(),
      },
    ],
    settings: { keys: input.keys },
  };
}

function addTracker(input: TrackerEntry) {
  return projectConnectionService.add(
    ORG_ID,
    input.projectId ?? PROJECT_ID,
    USER_ID,
    trackerInput(input)
  );
}

async function addedId(input: TrackerEntry): Promise<string> {
  const result = await addTracker(input);
  return result.ok ? (result.value[0]?.id ?? "") : "";
}

function scopeKeys(): string[] {
  return [...projectConnectionDbFake.scopes.values()]
    .map((row) => String(row.scopeKey))
    .sort();
}
