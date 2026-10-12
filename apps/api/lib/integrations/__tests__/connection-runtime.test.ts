import {
  type CreateIntegrationConnectionInput,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionDbFake,
  PRISMA_DB_NULL,
} from "@/lib/integrations/__tests__/support/connection-db.test-fake";
import {
  API_TOKEN,
  BOT_ACCOUNT,
  createOutboundTestConnection,
  createTestConnection,
  deliveryRow,
  fakeProvider,
  MISSING_ID,
  ORG_ID,
  OTHER_ORG_ID,
  PROVIDER_INBOUND_SECRET,
  PUBLIC_WEBHOOK_BASE,
  resetConnectionServiceFixtures,
  restoreConnectionServiceEnv,
  SITE_URL,
  testProviders,
  validateMock,
} from "@/lib/integrations/__tests__/support/connection-service.test-fixtures";
import {
  buildInboundUrl,
  createProviderContext,
  integrationConnectionService,
  loadConnectionByInboundKey,
  loadConnectionRuntime,
  recordConnectionPollResult,
} from "@/lib/integrations/connection-service";
import { ValidateConnectionReason } from "@/lib/integrations/types";

const mocks = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@repo/database", async () => {
  const fake = await import(
    "@/lib/integrations/__tests__/support/connection-db.test-fake"
  );
  return {
    withDb: (fn: (db: unknown) => unknown) => fn(fake.connectionDbFake.db),
    Prisma: { DbNull: fake.PRISMA_DB_NULL },
  };
});
vi.mock("@/lib/integrations/registry", async () => {
  const fixtures = await import(
    "@/lib/integrations/__tests__/support/connection-service.test-fixtures"
  );
  return { getIntegrationProvider: fixtures.getTestProvider };
});
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));

const REENTER_SECRETS_RE = /Re-enter the connection secrets\.$/;
const DEFAULT_INBOUND_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const UNREADABLE_INBOUND_SECRET_RE = /inbound secret could not be decrypted/;

beforeEach(resetConnectionServiceFixtures);
afterEach(restoreConnectionServiceEnv);

describe("integrationConnectionService.test", () => {
  it("records a successful check", async () => {
    const connection = await createConnection();
    const row = connectionDbFake.connections.get(connection.id)!;
    Object.assign(row, {
      status: IntegrationConnectionStatus.Error,
      lastError: "old failure",
      account: null,
    });
    validateMock.mockClear();

    const result = await integrationConnectionService.test(
      ORG_ID,
      connection.id
    );

    expect(validateMock.mock.calls[0][1]).toBe(ValidateConnectionReason.Test);
    expect(result).toEqual({
      ok: true,
      account: { externalAccountId: "bot-1", displayName: "AgentFlow Bot" },
      error: null,
    });
    expect(row).toMatchObject({
      status: IntegrationConnectionStatus.Active,
      lastError: null,
      account: BOT_ACCOUNT,
    });
  });

  it("records a failed check without re-enabling a disabled connection", async () => {
    const connection = await createConnection();
    const row = connectionDbFake.connections.get(connection.id)!;
    row.status = IntegrationConnectionStatus.Disabled;
    validateMock.mockResolvedValue({ ok: false, error: "401 Unauthorized" });

    const result = await integrationConnectionService.test(
      ORG_ID,
      connection.id
    );

    expect(result).toEqual({
      ok: false,
      account: { externalAccountId: "bot-1", displayName: "AgentFlow Bot" },
      error: "401 Unauthorized",
    });
    expect(row).toMatchObject({
      status: IntegrationConnectionStatus.Disabled,
      lastError: "401 Unauthorized",
    });
  });

  it("reports unreadable credentials as an error status", async () => {
    const connection = await createConnection();
    const row = connectionDbFake.connections.get(connection.id)!;
    row.credentialsEncrypted = "v1.corrupt";
    validateMock.mockClear();

    const result = await integrationConnectionService.test(
      ORG_ID,
      connection.id
    );

    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(REENTER_SECRETS_RE);
    expect(row.status).toBe(IntegrationConnectionStatus.Error);
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("returns null for a missing connection", async () => {
    await expect(
      integrationConnectionService.test(ORG_ID, MISSING_ID)
    ).resolves.toBeNull();
  });
});

describe("inbound endpoint", () => {
  it("returns the URL, the provider-generated secret and setup instructions", async () => {
    const connection = await createConnection();
    const row = connectionDbFake.connections.get(connection.id)!;

    const details = await integrationConnectionService.getInboundDetails(
      ORG_ID,
      connection.id
    );

    const inboundUrl = `${PUBLIC_WEBHOOK_BASE}/webhooks/integrations/${row.inboundKey}`;
    expect(details).toEqual({
      inboundUrl,
      inboundSecret: PROVIDER_INBOUND_SECRET,
      setupInstructions: `Send webhook events for Jira Cloud to ${inboundUrl}`,
    });
    expect(JSON.stringify(row)).not.toContain(PROVIDER_INBOUND_SECRET);
  });

  it("generates a default secret and empty instructions without an inbound side", async () => {
    const connection = await createOutboundConnection();

    const details = await integrationConnectionService.getInboundDetails(
      ORG_ID,
      connection.id
    );

    expect(details?.inboundSecret).toMatch(DEFAULT_INBOUND_SECRET_RE);
    expect(details?.setupInstructions).toBe("");
  });

  it("rotates the key and secret so the old URL stops resolving", async () => {
    const connection = await createConnection();
    const oldKey = String(
      connectionDbFake.connections.get(connection.id)?.inboundKey
    );
    testProviders.set(fakeProvider.key, {
      ...fakeProvider,
      inbound: { ...fakeProvider.inbound, generateSecret: undefined },
    });

    const rotated = await integrationConnectionService.rotateInbound(
      ORG_ID,
      connection.id
    );

    const newKey = String(
      connectionDbFake.connections.get(connection.id)?.inboundKey
    );
    expect(newKey).not.toBe(oldKey);
    expect(rotated?.inboundUrl).toContain(newKey);
    expect(rotated?.inboundSecret).not.toBe(PROVIDER_INBOUND_SECRET);
    await expect(loadConnectionByInboundKey(oldKey)).resolves.toBeNull();
    await expect(loadConnectionByInboundKey(newKey)).resolves.toMatchObject({
      inboundSecret: rotated?.inboundSecret,
    });
  });

  it("returns null for a foreign connection and throws for an unreadable secret", async () => {
    const connection = await createConnection();

    await expect(
      integrationConnectionService.getInboundDetails(
        OTHER_ORG_ID,
        connection.id
      )
    ).resolves.toBeNull();
    await expect(
      integrationConnectionService.rotateInbound(OTHER_ORG_ID, connection.id)
    ).resolves.toBeNull();

    connectionDbFake.connections.get(connection.id)!.inboundSecretEncrypted =
      "v1.corrupt";
    await expect(
      integrationConnectionService.getInboundDetails(ORG_ID, connection.id)
    ).rejects.toThrow(UNREADABLE_INBOUND_SECRET_RE);
  });
});

describe("integrationConnectionService.listDeliveries", () => {
  it("returns the newest deliveries of the connection within the organization", async () => {
    const connection = await createConnection();
    connectionDbFake.deliveries.push(
      deliveryRow(connection.id, "d-old", "2026-10-01T00:00:00Z"),
      deliveryRow(connection.id, "d-new", "2026-10-02T00:00:00Z"),
      {
        ...deliveryRow(connection.id, "d-foreign", "2026-10-03T00:00:00Z"),
        organizationId: OTHER_ORG_ID,
      }
    );

    const deliveries = await integrationConnectionService.listDeliveries(
      ORG_ID,
      connection.id
    );

    expect(deliveries.map((delivery) => delivery.deliveryId)).toEqual([
      "d-new",
      "d-old",
    ]);
    expect(deliveries[0]).toEqual({
      id: "row-d-new",
      deliveryId: "d-new",
      source: IntegrationDeliverySource.Webhook,
      eventType: "jira:issue_updated",
      outcome: IntegrationDeliveryOutcome.Accepted,
      detail: null,
      runCount: 1,
      receivedAt: new Date("2026-10-02T00:00:00Z"),
    });
  });

  it("clamps the limit and ignores malformed ids", async () => {
    const connection = await createConnection();

    await integrationConnectionService.listDeliveries(
      ORG_ID,
      connection.id,
      10_000
    );
    expect(
      connectionDbFake.db.integrationDelivery.findMany.mock.calls[0][0].take
    ).toBe(200);

    await expect(
      integrationConnectionService.listDeliveries(ORG_ID, "nope")
    ).resolves.toEqual([]);
    expect(
      connectionDbFake.db.integrationDelivery.findMany
    ).toHaveBeenCalledTimes(1);
  });
});

describe("runtime loading", () => {
  it("decrypts and validates the runtime for engine code", async () => {
    const connection = await createConnection();

    const loaded = await loadConnectionRuntime(ORG_ID, connection.id);

    expect(loaded?.provider).toBe(fakeProvider);
    expect(loaded?.record.id).toBe(connection.id);
    expect(loaded?.runtime).toEqual({
      id: connection.id,
      organizationId: ORG_ID,
      provider: fakeProvider.key,
      name: "Jira Cloud",
      config: { siteUrl: SITE_URL, project: "NORMALIZED" },
      secrets: { apiToken: API_TOKEN },
      account: BOT_ACCOUNT,
    });
  });

  it("returns null when the connection is missing, foreign, unregistered or unreadable", async () => {
    const connection = await createConnection();

    await expect(loadConnectionRuntime(ORG_ID, MISSING_ID)).resolves.toBeNull();
    await expect(
      loadConnectionRuntime(OTHER_ORG_ID, connection.id)
    ).resolves.toBeNull();

    testProviders.delete(fakeProvider.key);
    await expect(
      loadConnectionRuntime(ORG_ID, connection.id)
    ).resolves.toBeNull();
    testProviders.set(fakeProvider.key, fakeProvider);

    connectionDbFake.connections.get(connection.id)!.credentialsEncrypted =
      "v1.corrupt";
    await expect(
      loadConnectionRuntime(ORG_ID, connection.id)
    ).resolves.toBeNull();
  });

  it("returns null when the stored config no longer matches the provider schema", async () => {
    const connection = await createConnection();
    connectionDbFake.connections.get(connection.id)!.config = { siteUrl: 42 };

    await expect(
      loadConnectionRuntime(ORG_ID, connection.id)
    ).resolves.toBeNull();
  });

  it("resolves a connection by inbound key with its inbound secret", async () => {
    const connection = await createConnection();
    const inboundKey = String(
      connectionDbFake.connections.get(connection.id)?.inboundKey
    );

    const loaded = await loadConnectionByInboundKey(inboundKey);

    expect(loaded?.runtime.id).toBe(connection.id);
    expect(loaded?.inboundSecret).toBe(PROVIDER_INBOUND_SECRET);
  });

  it("rejects malformed inbound keys without querying", async () => {
    await expect(loadConnectionByInboundKey("../../etc")).resolves.toBeNull();
    await expect(loadConnectionByInboundKey("")).resolves.toBeNull();
    expect(
      connectionDbFake.db.integrationConnection.findUnique
    ).not.toHaveBeenCalled();
  });
});

describe("createProviderContext", () => {
  it("prefixes log lines, tags the connection and scrubs secret values", () => {
    const context = createProviderContext(
      {
        id: "conn-1",
        organizationId: ORG_ID,
        provider: fakeProvider.key,
        name: "Jira Cloud",
        config: {},
        secrets: { apiToken: API_TOKEN },
        account: null,
      },
      "[workflow-engine]"
    );

    context.log.warn(`request failed for ${API_TOKEN}`, {
      header: `Basic ${API_TOKEN}`,
      nested: { values: [API_TOKEN, 3] },
      error: new Error(`boom ${API_TOKEN}`),
    });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "[workflow-engine] request failed for [redacted]",
      {
        connectionId: "conn-1",
        organizationId: ORG_ID,
        provider: fakeProvider.key,
        header: "Basic [redacted]",
        nested: { values: ["[redacted]", 3] },
        error: "boom [redacted]",
      }
    );
    expect(context.now()).toBeInstanceOf(Date);
    expect(typeof context.http.request).toBe("function");
  });
});

describe("buildInboundUrl", () => {
  it("prefers PUBLIC_WEBHOOK_BASE_URL and strips trailing slashes", () => {
    vi.stubEnv("PUBLIC_WEBHOOK_BASE_URL", "https://hooks.example.test//");
    expect(buildInboundUrl("key-1")).toBe(
      "https://hooks.example.test/webhooks/integrations/key-1"
    );
  });

  it("falls back to NEXT_PUBLIC_API_URL, then to the local API", () => {
    vi.stubEnv("PUBLIC_WEBHOOK_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    expect(buildInboundUrl("key-1")).toBe(
      "https://api.example.test/webhooks/integrations/key-1"
    );

    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    expect(buildInboundUrl("key-1")).toBe(
      "http://localhost:3002/webhooks/integrations/key-1"
    );
  });
});

describe("recordConnectionPollResult", () => {
  it("stores the cursor and error and schedules the next poll", async () => {
    const connection = await createConnection({
      deliveryMode: IntegrationDeliveryMode.Poll,
    });
    const row = connectionDbFake.connections.get(connection.id)!;
    const nextPollAt = new Date("2026-10-04T12:00:00Z");

    await recordConnectionPollResult(connection.id, {
      cursor: { since: "2026-10-04T11:58:00Z" },
      error: null,
      nextPollAt,
    });
    expect(row).toMatchObject({
      pollCursor: { since: "2026-10-04T11:58:00Z" },
      lastError: null,
      nextPollAt,
    });
    expect(row.lastPolledAt).toBeInstanceOf(Date);

    await recordConnectionPollResult(connection.id, {
      error: "x".repeat(1500),
      nextPollAt,
    });
    expect(row.pollCursor).toEqual({ since: "2026-10-04T11:58:00Z" });
    expect(String(row.lastError)).toHaveLength(1000);
    expect(row.status).toBe(IntegrationConnectionStatus.Active);

    await recordConnectionPollResult(connection.id, {
      cursor: null,
      nextPollAt,
    });
    expect(row.pollCursor).toBeNull();
    expect(
      connectionDbFake.db.integrationConnection.updateMany.mock.calls.at(
        -1
      )?.[0].data?.pollCursor
    ).toBe(PRISMA_DB_NULL);
  });
});

function createConnection(
  overrides: Partial<CreateIntegrationConnectionInput> = {}
): Promise<IntegrationConnection> {
  return createTestConnection(integrationConnectionService, overrides);
}

function createOutboundConnection(): Promise<IntegrationConnection> {
  return createOutboundTestConnection(integrationConnectionService);
}
