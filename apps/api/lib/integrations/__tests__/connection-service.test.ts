import {
  type CreateIntegrationConnectionInput,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
} from "@repo/api/src/types/integration";
import { Status } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionDbFake } from "@/lib/integrations/__tests__/support/connection-db.test-fake";
import {
  API_TOKEN,
  baseInput,
  createOutboundTestConnection,
  createTestConnection,
  fakeProvider,
  MISSING_ID,
  ORG_ID,
  OTHER_ORG_ID,
  outboundProvider,
  PUBLIC_WEBHOOK_BASE,
  resetConnectionServiceFixtures,
  restoreConnectionServiceEnv,
  SECOND_TOKEN,
  SHORT_TOKEN,
  SITE_URL,
  USER_ID,
  validateMock,
} from "@/lib/integrations/__tests__/support/connection-service.test-fixtures";
import { ADMIN_VIEWER } from "@/lib/integrations/connection/url-redaction";
import {
  integrationConnectionService,
  loadConnectionRuntime,
} from "@/lib/integrations/connection-service";
import { ValidateConnectionReason } from "@/lib/integrations/types";

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

const SEALED_VALUE_RE = /^v1\./;
const MEMBER_VIEWER = { isAdmin: false };
const OTHER_SITE_URL = "https://other.atlassian.net";
const INVALID_SITE_URL_RE = /^Invalid configuration: siteUrl: /;
const MISSING_API_TOKEN_RE = /^Invalid credentials: apiToken: /;

beforeEach(resetConnectionServiceFixtures);
afterEach(restoreConnectionServiceEnv);

describe("integrationConnectionService.create", () => {
  it("validates with the provider, seals secrets and returns only hints", async () => {
    const connection = await createConnection({
      config: { siteUrl: SITE_URL, apiToken: "smuggled-in-config" },
    });

    expect(validateMock).toHaveBeenCalledTimes(1);
    const [context, reason] = validateMock.mock.calls[0];
    expect(reason).toBe(ValidateConnectionReason.Save);
    expect(context.connection.secrets).toEqual({ apiToken: API_TOKEN });
    expect(context.connection.config).toEqual({ siteUrl: SITE_URL });
    expect(context.connection.organizationId).toBe(ORG_ID);

    expect(connection).toMatchObject({
      provider: fakeProvider.key,
      name: "Jira Cloud",
      status: IntegrationConnectionStatus.Active,
      config: { siteUrl: SITE_URL, project: "NORMALIZED" },
      secretFields: {
        apiToken: { isSet: true, lastFour: "WXYZ" },
        extraToken: { isSet: false, lastFour: null },
      },
      account: { externalAccountId: "bot-1", displayName: "AgentFlow Bot" },
      deliveryMode: IntegrationDeliveryMode.Webhook,
      usageCount: 0,
      lastError: null,
    });
    expect(connection.lastValidatedAt).toBeInstanceOf(Date);

    const row = connectionDbFake.connections.get(connection.id);
    expect(row?.createdById).toBe(USER_ID);
    expect(row?.credentialsEncrypted).toMatch(SEALED_VALUE_RE);
    expect(JSON.stringify(row)).not.toContain(API_TOKEN);
    expect(JSON.stringify(connection)).not.toContain(API_TOKEN);
    expect(connection.inboundUrl).toBe(
      `${PUBLIC_WEBHOOK_BASE}/webhooks/integrations/${row?.inboundKey}`
    );
  });

  it("marks short secrets as set without revealing a last-four hint", async () => {
    const connection = await createConnection({
      secrets: { apiToken: SHORT_TOKEN },
    });

    expect(connection.secretFields.apiToken).toEqual({
      isSet: true,
      lastFour: null,
    });
  });

  it("schedules a first poll right away in poll mode", async () => {
    const connection = await createConnection({
      deliveryMode: IntegrationDeliveryMode.Poll,
    });

    expect(connection.inboundUrl).toBeNull();
    expect(
      connectionDbFake.connections.get(connection.id)?.nextPollAt
    ).toBeInstanceOf(Date);
  });

  it("rejects an unknown provider", async () => {
    const result = await integrationConnectionService.create(ORG_ID, USER_ID, {
      ...baseInput(),
      provider: "unknown",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: 'Unknown integration provider "unknown"',
      },
    });
  });

  it("rejects a delivery mode the provider does not support", async () => {
    const result = await integrationConnectionService.create(ORG_ID, USER_ID, {
      ...baseInput(),
      provider: outboundProvider.key,
      config: {},
      secrets: { webhookUrl: "https://teams.example.test/hook" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.status).toBe(Status.BadRequest);
    expect(connectionDbFake.connections.size).toBe(0);
  });

  it("rejects invalid config before calling the provider", async () => {
    const result = await integrationConnectionService.create(ORG_ID, USER_ID, {
      ...baseInput(),
      config: { siteUrl: "not a url" },
    });

    expect(result.ok ? null : result.error.message).toMatch(
      INVALID_SITE_URL_RE
    );
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("rejects missing required secrets", async () => {
    const result = await integrationConnectionService.create(ORG_ID, USER_ID, {
      ...baseInput(),
      secrets: { apiToken: "" },
    });

    expect(result.ok ? null : result.error.message).toMatch(
      MISSING_API_TOKEN_RE
    );
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("returns the provider's message (secrets scrubbed) when validation fails", async () => {
    validateMock.mockResolvedValue({
      ok: false,
      error: `Jira rejected token ${API_TOKEN}`,
    });

    const result = await integrationConnectionService.create(
      ORG_ID,
      USER_ID,
      baseInput()
    );

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: "Jira rejected token [redacted]",
      },
    });
    expect(connectionDbFake.connections.size).toBe(0);
  });

  it("turns a throwing provider validate into a generic 400", async () => {
    validateMock.mockRejectedValue(new Error(`socket closed ${API_TOKEN}`));

    const result = await integrationConnectionService.create(
      ORG_ID,
      USER_ID,
      baseInput()
    );

    expect(result.ok ? null : result.error).toEqual({
      status: Status.BadRequest,
      message:
        "The connection could not be validated. Check the settings and try again.",
    });
  });
});

describe("integrationConnectionService.list / get", () => {
  it("lists the organization's connections with their usage count", async () => {
    const first = await createConnection();
    await createConnection({ name: "Second" });
    connectionDbFake.usage.set(first.id, {
      triggers: 2,
      actions: 1,
      projectRepositories: 0,
    });
    await createTestConnection(integrationConnectionService, {}, OTHER_ORG_ID);

    const connections = await integrationConnectionService.list(
      ORG_ID,
      ADMIN_VIEWER
    );

    expect(connections.map((connection) => connection.name)).toEqual([
      "Jira Cloud",
      "Second",
    ]);
    expect(connections[0].usageCount).toBe(3);
  });

  it("returns null for another organization's connection or a malformed id", async () => {
    const connection = await createConnection();

    await expect(
      integrationConnectionService.get(
        OTHER_ORG_ID,
        connection.id,
        ADMIN_VIEWER
      )
    ).resolves.toBeNull();
    await expect(
      integrationConnectionService.get(ORG_ID, "not-a-uuid", ADMIN_VIEWER)
    ).resolves.toBeNull();
    await expect(
      integrationConnectionService.get(ORG_ID, connection.id, ADMIN_VIEWER)
    ).resolves.toMatchObject({ id: connection.id });
  });

  it("shows members who are not admins only the origin of url config fields", async () => {
    const siteUrl = "https://jira.example.test/context/path?token=abc";
    const connection = await createConnection({ config: { siteUrl } });

    const [listed] = await integrationConnectionService.list(
      ORG_ID,
      MEMBER_VIEWER
    );
    const single = await integrationConnectionService.get(
      ORG_ID,
      connection.id,
      MEMBER_VIEWER
    );
    const asAdmin = await integrationConnectionService.get(
      ORG_ID,
      connection.id,
      ADMIN_VIEWER
    );

    expect(listed.config).toEqual({
      siteUrl: "https://jira.example.test/…",
      project: "NORMALIZED",
    });
    expect(single?.config).toEqual(listed.config);
    expect(asAdmin?.config.siteUrl).toBe(siteUrl);
  });
});

describe("integrationConnectionService.update", () => {
  it("renames without re-validating", async () => {
    const connection = await createConnection();
    validateMock.mockClear();

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { name: "Renamed", secrets: { apiToken: null } }
    );

    expect(result.ok ? result.value.name : null).toBe("Renamed");
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("keeps omitted secrets, replaces given ones and clears empty ones", async () => {
    const connection = await createConnection({
      secrets: { apiToken: API_TOKEN, extraToken: SECOND_TOKEN },
    });
    validateMock.mockClear();

    const replaced = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { secrets: { extraToken: "" } }
    );

    expect(validateMock.mock.calls[0][0].connection.secrets).toEqual({
      apiToken: API_TOKEN,
    });
    expect(replaced.ok ? replaced.value.secretFields : null).toEqual({
      apiToken: { isSet: true, lastFour: "WXYZ" },
      extraToken: { isSet: false, lastFour: null },
    });

    const rotated = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { secrets: { apiToken: SECOND_TOKEN } }
    );
    expect(rotated.ok ? rotated.value.secretFields.apiToken : null).toEqual({
      isSet: true,
      lastFour: "9876",
    });
    const runtime = await loadConnectionRuntime(ORG_ID, connection.id);
    expect(runtime?.runtime.secrets).toEqual({ apiToken: SECOND_TOKEN });
  });

  it("does not re-validate when the form re-sends the stored config", async () => {
    const connection = await createConnection();
    validateMock.mockClear();

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      {
        name: "Renamed",
        config: connection.config,
        secrets: { apiToken: null },
      }
    );

    expect(result.ok ? result.value.name : null).toBe("Renamed");
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("re-validates a config change that keeps the site with the stored secrets", async () => {
    const connection = await createConnection();
    validateMock.mockClear();

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { config: { siteUrl: SITE_URL, project: "OTHER" } }
    );

    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock.mock.calls[0][0].connection.secrets).toEqual({
      apiToken: API_TOKEN,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a site change without the secrets and never calls the provider", async () => {
    const connection = await createConnection();
    validateMock.mockClear();

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { config: { siteUrl: "https://attacker.example" } }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: "Re-enter API token when changing Site URL.",
      },
    });
    expect(validateMock).not.toHaveBeenCalled();
    expect(connectionDbFake.connections.get(connection.id)).toMatchObject({
      config: { siteUrl: SITE_URL, project: "NORMALIZED" },
    });
  });

  it("requires every secret that is set when the site changes", async () => {
    const connection = await createConnection({
      secrets: { apiToken: API_TOKEN, extraToken: SECOND_TOKEN },
    });
    validateMock.mockClear();

    const partial = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      {
        config: { siteUrl: OTHER_SITE_URL },
        secrets: { apiToken: SECOND_TOKEN, extraToken: "" },
      }
    );
    expect(partial.ok ? null : partial.error.message).toBe(
      "Re-enter Extra token when changing Site URL."
    );
    expect(validateMock).not.toHaveBeenCalled();

    const complete = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      {
        config: { siteUrl: OTHER_SITE_URL },
        secrets: { apiToken: SECOND_TOKEN, extraToken: API_TOKEN },
      }
    );
    expect(complete.ok ? complete.value.config.siteUrl : null).toBe(
      OTHER_SITE_URL
    );
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock.mock.calls[0][0].connection).toMatchObject({
      config: { siteUrl: OTHER_SITE_URL },
      secrets: { apiToken: SECOND_TOKEN, extraToken: API_TOKEN },
    });
  });

  it("leaves the row untouched when re-validation fails", async () => {
    const connection = await createConnection();
    validateMock.mockResolvedValue({ ok: false, error: "Site unreachable" });

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      {
        name: "Renamed",
        config: { siteUrl: OTHER_SITE_URL },
        secrets: { apiToken: SECOND_TOKEN },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: { status: Status.BadRequest, message: "Site unreachable" },
    });
    expect(connectionDbFake.connections.get(connection.id)).toMatchObject({
      name: "Jira Cloud",
      config: { siteUrl: SITE_URL, project: "NORMALIZED" },
    });
  });

  it("disables on request and never re-enables through re-validation", async () => {
    const connection = await createConnection();

    const disabled = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { status: IntegrationConnectionStatus.Disabled }
    );
    expect(disabled.ok ? disabled.value.status : null).toBe(
      IntegrationConnectionStatus.Disabled
    );

    const revalidated = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { secrets: { apiToken: SECOND_TOKEN } }
    );
    expect(revalidated.ok ? revalidated.value.status : null).toBe(
      IntegrationConnectionStatus.Disabled
    );
  });

  it("clears an error status after a successful re-validation", async () => {
    const connection = await createConnection();
    connectionDbFake.connections.get(connection.id)!.status =
      IntegrationConnectionStatus.Error;

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { secrets: { apiToken: SECOND_TOKEN } }
    );

    expect(result.ok ? result.value.status : null).toBe(
      IntegrationConnectionStatus.Active
    );
  });

  it("schedules polling from a fresh cursor when entering poll mode and unschedules on leave", async () => {
    const connection = await createConnection();
    const row = connectionDbFake.connections.get(connection.id)!;
    row.pollCursor = { since: "2026-01-01T00:00:00Z" };

    await integrationConnectionService.update(ORG_ID, connection.id, {
      deliveryMode: IntegrationDeliveryMode.Poll,
    });
    expect(row.nextPollAt).toBeInstanceOf(Date);
    expect(row.pollCursor).toBeNull();

    await integrationConnectionService.update(ORG_ID, connection.id, {
      deliveryMode: IntegrationDeliveryMode.None,
    });
    expect(row.nextPollAt).toBeNull();
  });

  it("brings the next poll forward when the poll interval shrinks", async () => {
    const connection = await createConnection({
      deliveryMode: IntegrationDeliveryMode.Poll,
      pollIntervalSeconds: 3600,
    });
    const row = connectionDbFake.connections.get(connection.id)!;
    const inAnHour = new Date(Date.now() + 3600 * 1000);
    row.nextPollAt = inAnHour;

    await integrationConnectionService.update(ORG_ID, connection.id, {
      pollIntervalSeconds: 60,
    });

    const nextPollAt = row.nextPollAt as Date;
    expect(nextPollAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 1000);
    expect(row.pollIntervalSeconds).toBe(60);

    // A longer interval never pushes back a poll that is due sooner.
    await integrationConnectionService.update(ORG_ID, connection.id, {
      pollIntervalSeconds: 1800,
    });
    expect(row.nextPollAt).toEqual(nextPollAt);
  });

  it("rejects an unsupported delivery mode", async () => {
    const connection = await createOutboundConnection();

    const result = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { deliveryMode: IntegrationDeliveryMode.Poll }
    );

    expect(result.ok ? null : result.error.status).toBe(Status.BadRequest);
  });

  it("returns 404 for a missing or foreign connection", async () => {
    const connection = await createConnection();

    for (const [organizationId, id] of [
      [OTHER_ORG_ID, connection.id],
      [ORG_ID, MISSING_ID],
      [ORG_ID, "not-a-uuid"],
    ]) {
      const result = await integrationConnectionService.update(
        organizationId,
        id,
        { name: "x" }
      );
      expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
    }
  });

  it("lets the admin re-enter secrets when the stored ones no longer decrypt", async () => {
    const connection = await createConnection();
    connectionDbFake.connections.get(connection.id)!.credentialsEncrypted =
      "v1.corrupt";

    const configOnly = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { config: { siteUrl: SITE_URL } }
    );
    expect(configOnly.ok ? null : configOnly.error.message).toMatch(
      MISSING_API_TOKEN_RE
    );

    const reEntered = await integrationConnectionService.update(
      ORG_ID,
      connection.id,
      { secrets: { apiToken: SECOND_TOKEN } }
    );
    expect(reEntered.ok).toBe(true);
  });
});

describe("integrationConnectionService.remove", () => {
  it("deletes an unused connection", async () => {
    const connection = await createConnection();

    await expect(
      integrationConnectionService.remove(ORG_ID, connection.id)
    ).resolves.toEqual({ ok: true, value: { deleted: true } });
    expect(connectionDbFake.connections.size).toBe(0);
  });

  it("refuses with 409 while workflows use the connection", async () => {
    const connection = await createConnection();
    connectionDbFake.usage.set(connection.id, {
      triggers: 1,
      actions: 1,
      projectRepositories: 0,
    });

    const result = await integrationConnectionService.remove(
      ORG_ID,
      connection.id
    );

    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      message:
        "The connection is used by 2 workflow trigger(s), action(s) or project repositories. Remove them from their workflows and projects first.",
    });
    expect(connectionDbFake.connections.size).toBe(1);
  });

  it("refuses with 409 while a project uses one of its repositories", async () => {
    const connection = await createConnection();
    connectionDbFake.usage.set(connection.id, {
      triggers: 0,
      actions: 0,
      projectRepositories: 1,
    });

    const result = await integrationConnectionService.remove(
      ORG_ID,
      connection.id
    );

    expect(result.ok ? null : result.error.status).toBe(Status.Conflict);
    expect(connectionDbFake.connections.size).toBe(1);
  });

  it("refuses with 409 when a workflow starts using it during the delete", async () => {
    const connection = await createConnection();
    connectionDbFake.db.integrationConnection.deleteMany.mockResolvedValueOnce({
      count: 0,
    });

    const result = await integrationConnectionService.remove(
      ORG_ID,
      connection.id
    );

    expect(result.ok ? null : result.error.status).toBe(Status.Conflict);
  });

  it("returns 404 for a foreign connection", async () => {
    const connection = await createConnection();

    const result = await integrationConnectionService.remove(
      OTHER_ORG_ID,
      connection.id
    );

    expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
    expect(connectionDbFake.connections.size).toBe(1);
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
