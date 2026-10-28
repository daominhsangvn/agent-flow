import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Status } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionDbFake } from "@/lib/integrations/__tests__/support/connection-db.test-fake";
import {
  createTestConnection,
  ORG_ID,
  OTHER_ORG_ID,
  resetConnectionServiceFixtures,
  restoreConnectionServiceEnv,
  testProviders,
  USER_ID,
} from "@/lib/integrations/__tests__/support/connection-service.test-fixtures";
import { ADMIN_VIEWER } from "@/lib/integrations/connection/url-redaction";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  getServerConnectionSpecs,
  isProvidedByServer,
  isServerConnection,
  LOCAL_GIT_CONNECTION_NAME,
  SERVER_CONNECTION_READ_ONLY_MESSAGE,
} from "@/lib/integrations/server-connections";
import { defineIntegrationProvider } from "@/lib/integrations/types";

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn() }));

vi.mock("@repo/database", async () => {
  const fake = await import(
    "@/lib/integrations/__tests__/support/connection-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) => fn(fake.connectionDbFake.db);
  // The advisory lock is recorded, not taken; the tx client is the same fake.
  withDb.tx = (fn: (tx: unknown) => unknown) =>
    fn({ ...fake.connectionDbFake.db, $executeRaw: mocks.executeRaw });
  return { withDb, Prisma: { DbNull: fake.PRISMA_DB_NULL } };
});
vi.mock("@/lib/integrations/registry", async () => {
  const fixtures = await import(
    "@/lib/integrations/__tests__/support/connection-service.test-fixtures"
  );
  return { getIntegrationProvider: fixtures.getTestProvider };
});

const TOKEN = "gitea-token-0001";
const NEW_TOKEN = "gitea-token-0002";
const SERVER_URL = "http://localhost:3300";
const RUNNER_URL = "http://host.docker.internal:3300";

/** Stand-in for the Local Git provider: same config, secrets and origin fields. */
const validateLocalGit = vi.fn();
const localGitProvider = defineIntegrationProvider({
  key: IntegrationProviderKey.LocalGit,
  displayName: "Local Git",
  description: "Gitea on this machine",
  connection: {
    configSchema: z.object({
      serverUrl: z.url(),
      runnerUrl: z.string().default(""),
      owner: z.string().default(""),
    }),
    secretsSchema: z.object({ token: z.string().min(1) }),
    fields: [
      { key: "serverUrl", label: "Server URL", kind: IntegrationFieldKind.Url },
      {
        key: "token",
        label: "Access token",
        kind: IntegrationFieldKind.Secret,
      },
    ],
    credentialOriginFields: ["serverUrl", "runnerUrl"],
    validate: validateLocalGit,
  },
  triggers: [],
  actions: [],
});

beforeEach(() => {
  resetConnectionServiceFixtures();
  testProviders.set(localGitProvider.key, localGitProvider);
  validateLocalGit.mockResolvedValue({
    ok: true,
    account: {
      externalAccountId: "1",
      displayName: "agentflow",
      aliases: ["agentflow"],
      details: {},
    },
  });
  vi.stubEnv("LOCAL_GIT_TOKEN", TOKEN);
  vi.stubEnv("LOCAL_GIT_SERVER_URL", SERVER_URL);
  vi.stubEnv("LOCAL_GIT_RUNNER_URL", RUNNER_URL);
  vi.stubEnv("LOCAL_GIT_OWNER", "");
});
afterEach(restoreConnectionServiceEnv);

describe("getServerConnectionSpecs", () => {
  it("provides Local Git only when the API has its token", () => {
    expect(getServerConnectionSpecs({})).toEqual([]);
    expect(getServerConnectionSpecs({ LOCAL_GIT_TOKEN: "  " })).toEqual([]);
    expect(getServerConnectionSpecs({ LOCAL_GIT_TOKEN: ` ${TOKEN} ` })).toEqual(
      [
        {
          provider: IntegrationProviderKey.LocalGit,
          name: LOCAL_GIT_CONNECTION_NAME,
          config: { serverUrl: SERVER_URL, runnerUrl: "", owner: "" },
          secrets: { token: TOKEN },
        },
      ]
    );
    expect(isProvidedByServer(IntegrationProviderKey.LocalGit, {})).toBe(false);
    expect(
      isProvidedByServer(IntegrationProviderKey.LocalGit, {
        LOCAL_GIT_TOKEN: TOKEN,
      })
    ).toBe(true);
    expect(
      isProvidedByServer(IntegrationProviderKey.Jira, {
        LOCAL_GIT_TOKEN: TOKEN,
      })
    ).toBe(false);
  });

  it("recognises a server connection by its provider and missing creator", () => {
    expect(
      isServerConnection({
        provider: IntegrationProviderKey.LocalGit,
        createdById: null,
      })
    ).toBe(true);
    expect(
      isServerConnection({
        provider: IntegrationProviderKey.LocalGit,
        createdById: USER_ID,
      })
    ).toBe(false);
    expect(
      isServerConnection({
        provider: IntegrationProviderKey.Jira,
        createdById: null,
      })
    ).toBe(false);
  });
});

describe("server-provided connections", () => {
  it("gives every organization its Local Git connection when the list is read", async () => {
    const connections = await listConnections();

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      provider: IntegrationProviderKey.LocalGit,
      name: LOCAL_GIT_CONNECTION_NAME,
      providedByServer: true,
      status: IntegrationConnectionStatus.Active,
      deliveryMode: IntegrationDeliveryMode.None,
      config: { serverUrl: SERVER_URL, runnerUrl: RUNNER_URL, owner: "" },
      secretFields: { token: { isSet: true, lastFour: "0001" } },
      account: { externalAccountId: "1", displayName: "agentflow" },
    });
    const [other] = await listConnections(OTHER_ORG_ID);
    expect(other?.providedByServer).toBe(true);
    expect(other?.id).not.toBe(connections[0]?.id);
    expect(
      [...connectionDbFake.connections.values()].map((row) => row.createdById)
    ).toEqual([null, null]);
    // Each write ran under the organization's advisory lock.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
  });

  it("checks it once, and again only when the environment changes", async () => {
    await listConnections();
    await listConnections();
    expect(validateLocalGit).toHaveBeenCalledTimes(1);

    vi.stubEnv("LOCAL_GIT_TOKEN", NEW_TOKEN);
    const [refreshed] = await listConnections();

    expect(validateLocalGit).toHaveBeenCalledTimes(2);
    expect(refreshed?.secretFields).toEqual({
      token: { isSet: true, lastFour: "0002" },
    });
    expect(connectionDbFake.connections.size).toBe(1);
  });

  it("stores a failed check as an error and checks it again a minute later", async () => {
    validateLocalGit.mockResolvedValue({
      ok: false,
      error: "Could not reach Local Git",
    });

    const [failed] = await listConnections();
    expect(failed).toMatchObject({
      providedByServer: true,
      status: IntegrationConnectionStatus.Error,
      lastError: "Could not reach Local Git",
    });
    await listConnections();
    expect(validateLocalGit).toHaveBeenCalledTimes(1);

    const row = connectionDbFake.connections.get(failed?.id ?? "");
    if (row) {
      row.updatedAt = new Date(Date.now() - 2 * 60_000);
    }
    validateLocalGit.mockResolvedValue({ ok: true, account: null });
    const [recovered] = await listConnections();

    expect(validateLocalGit).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      id: failed?.id,
      status: IntegrationConnectionStatus.Active,
      lastError: null,
    });
  });

  it("provides nothing without the token", async () => {
    vi.stubEnv("LOCAL_GIT_TOKEN", "");

    expect(await listConnections()).toEqual([]);
    expect(validateLocalGit).not.toHaveBeenCalled();
  });

  it("adopts the Local Git connection an admin added for the same server", async () => {
    vi.stubEnv("LOCAL_GIT_TOKEN", "");
    const manual = await addLocalGitByHand(SERVER_URL);
    vi.stubEnv("LOCAL_GIT_TOKEN", TOKEN);

    const connections = await listConnections();

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: manual.id,
      name: LOCAL_GIT_CONNECTION_NAME,
      providedByServer: true,
      config: { serverUrl: SERVER_URL, runnerUrl: RUNNER_URL, owner: "" },
      secretFields: { token: { isSet: true, lastFour: "0001" } },
    });
    expect(connectionDbFake.connections.get(manual.id)?.createdById).toBeNull();
  });

  it("adds its own connection next to one an admin added for another server", async () => {
    vi.stubEnv("LOCAL_GIT_TOKEN", "");
    const manual = await addLocalGitByHand("http://git.example.test:3300");
    vi.stubEnv("LOCAL_GIT_TOKEN", TOKEN);

    const connections = await listConnections();

    expect(
      connections.map((connection) => [
        connection.id === manual.id,
        connection.providedByServer,
      ])
    ).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("refuses to add, edit or delete it while the server provides it", async () => {
    const [provided] = await listConnections();
    const id = provided?.id ?? "";

    const created = await integrationConnectionService.create(ORG_ID, USER_ID, {
      provider: IntegrationProviderKey.LocalGit,
      name: "My Local Git",
      config: { serverUrl: SERVER_URL },
      secrets: { token: TOKEN },
      deliveryMode: IntegrationDeliveryMode.None,
      pollIntervalSeconds: 120,
    });
    const updated = await integrationConnectionService.update(ORG_ID, id, {
      name: "Renamed",
    });
    const removed = await integrationConnectionService.remove(ORG_ID, id);

    expect(!created.ok && created.error).toEqual({
      status: Status.BadRequest,
      message:
        "Local Git is provided by the server: every organization already has its connection.",
    });
    expect(!updated.ok && updated.error.message).toBe(
      SERVER_CONNECTION_READ_ONLY_MESSAGE
    );
    expect(!removed.ok && removed.error.message).toBe(
      SERVER_CONNECTION_READ_ONLY_MESSAGE
    );
    expect(connectionDbFake.connections.size).toBe(1);
  });

  it("hands the connection back to the admins once the server stops providing it", async () => {
    const [provided] = await listConnections();
    vi.stubEnv("LOCAL_GIT_TOKEN", "");

    const [listed] = await listConnections();
    const removed = await integrationConnectionService.remove(
      ORG_ID,
      provided?.id ?? ""
    );

    expect(listed?.providedByServer).toBe(false);
    expect(removed.ok).toBe(true);
  });

  it("leaves the other connections alone", async () => {
    const own = await createTestConnection(integrationConnectionService);

    const connections = await listConnections();

    expect(
      connections.map((connection) => connection.providedByServer)
    ).toEqual([false, true]);
    expect(connections[0]?.id).toBe(own.id);
  });
});

function listConnections(organizationId = ORG_ID) {
  return integrationConnectionService.list(organizationId, ADMIN_VIEWER);
}

/** A Local Git connection added through Settings (it has a creator). */
async function addLocalGitByHand(serverUrl: string) {
  const created = await integrationConnectionService.create(ORG_ID, USER_ID, {
    provider: IntegrationProviderKey.LocalGit,
    name: "Workshop Git",
    config: { serverUrl, runnerUrl: RUNNER_URL, owner: "workshop" },
    secrets: { token: "manual-token-9999" },
    deliveryMode: IntegrationDeliveryMode.None,
    pollIntervalSeconds: 120,
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.value;
}
