import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
  service: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    getInboundDetails: vi.fn(),
    rotateInbound: vi.fn(),
    listDeliveries: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  integrationConnectionService: mocks.service,
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

import { GET as getDeliveries } from "./[id]/deliveries/route";
import { POST as rotateInbound } from "./[id]/inbound/rotate/route";
import { GET as getInbound } from "./[id]/inbound/route";
import {
  DELETE as deleteConnection,
  GET as getConnection,
  PATCH as patchConnection,
} from "./[id]/route";
import { POST as testConnection } from "./[id]/test/route";
import { POST as createConnection, GET as listConnections } from "./route";

const CONNECTION_ID = "0199a5f0-0000-7000-8000-000000000001";
const BASE_URL = "http://localhost/integrations/connections";

const CONNECTION: IntegrationConnection = {
  id: CONNECTION_ID,
  managedByWorkflowId: null,
  provider: IntegrationProviderKey.Jira,
  name: "Jira Cloud",
  status: IntegrationConnectionStatus.Active,
  config: { siteUrl: "https://example.atlassian.net" },
  secretFields: { apiToken: { isSet: true, lastFour: "WXYZ" } },
  account: { externalAccountId: "bot-1", displayName: "Bot" },
  deliveryMode: IntegrationDeliveryMode.Webhook,
  pollIntervalSeconds: 120,
  inboundUrl: "https://hooks.example.test/webhooks/integrations/key",
  lastPolledAt: null,
  lastDeliveryAt: null,
  lastValidatedAt: null,
  lastError: null,
  usageCount: 0,
  createdAt: new Date("2026-10-04T00:00:00Z"),
  updatedAt: new Date("2026-10-04T00:00:00Z"),
};

const INBOUND_DETAILS = {
  inboundUrl: "https://hooks.example.test/webhooks/integrations/key",
  inboundSecret: "inbound-secret",
  setupInstructions: "Configure the webhook",
};

function request(method: string, path = "", body?: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function idParams() {
  return { params: Promise.resolve({ id: CONNECTION_ID }) };
}

function noParams() {
  return { params: Promise.resolve({}) };
}

function asAdmin() {
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true, reason: "admin" });
}

function asMember() {
  mocks.getOrgAdminStatus.mockResolvedValue({
    isAdmin: false,
    reason: "not_admin",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reads are open to every org member", () => {
  beforeEach(asMember);

  it("lists the organization's connections for a viewer who is not an admin", async () => {
    mocks.service.list.mockResolvedValue([CONNECTION]);

    const response = await listConnections(request("GET"), noParams());

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.connections).toHaveLength(1);
    expect(mocks.service.list).toHaveBeenCalledWith("org-1", {
      isAdmin: false,
    });
    expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
      "auth-org-1",
      "auth-user-1"
    );
  });

  it("reads as an admin viewer for org admins", async () => {
    asAdmin();
    mocks.service.list.mockResolvedValue([]);
    mocks.service.get.mockResolvedValue(CONNECTION);

    await listConnections(request("GET"), noParams());
    await getConnection(request("GET", `/${CONNECTION_ID}`), idParams());

    expect(mocks.service.list).toHaveBeenCalledWith("org-1", {
      isAdmin: true,
    });
    expect(mocks.service.get).toHaveBeenCalledWith("org-1", CONNECTION_ID, {
      isAdmin: true,
    });
  });

  it("returns one connection or 404", async () => {
    mocks.service.get
      .mockResolvedValueOnce(CONNECTION)
      .mockResolvedValueOnce(null);

    const found = await getConnection(
      request("GET", `/${CONNECTION_ID}`),
      idParams()
    );
    const missing = await getConnection(
      request("GET", `/${CONNECTION_ID}`),
      idParams()
    );

    expect(found.status).toBe(200);
    expect(mocks.service.get).toHaveBeenCalledWith("org-1", CONNECTION_ID, {
      isAdmin: false,
    });
    expect(missing.status).toBe(404);
  });

  it("lists deliveries after confirming the connection exists", async () => {
    mocks.service.get.mockResolvedValue(CONNECTION);
    mocks.service.listDeliveries.mockResolvedValue([
      {
        id: "d-1",
        deliveryId: "atlassian-1",
        source: IntegrationDeliverySource.Webhook,
        eventType: "jira:issue_updated",
        outcome: IntegrationDeliveryOutcome.Accepted,
        detail: null,
        runCount: 1,
        receivedAt: new Date("2026-10-04T00:00:00Z"),
      },
    ]);

    const response = await getDeliveries(
      request("GET", `/${CONNECTION_ID}/deliveries`),
      idParams()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.deliveries).toHaveLength(1);
    expect(mocks.service.listDeliveries).toHaveBeenCalledWith(
      "org-1",
      CONNECTION_ID
    );
  });

  it("returns 404 for the deliveries of a missing connection", async () => {
    mocks.service.get.mockResolvedValue(null);

    const response = await getDeliveries(
      request("GET", `/${CONNECTION_ID}/deliveries`),
      idParams()
    );

    expect(response.status).toBe(404);
    expect(mocks.service.listDeliveries).not.toHaveBeenCalled();
  });
});

describe("admin-only endpoints", () => {
  const adminOnly = [
    {
      name: "POST /integrations/connections",
      call: () =>
        createConnection(
          request("POST", "", {
            provider: IntegrationProviderKey.Jira,
            name: "x",
          }),
          noParams()
        ),
    },
    {
      name: "PATCH /integrations/connections/{id}",
      call: () =>
        patchConnection(
          request("PATCH", `/${CONNECTION_ID}`, { name: "x" }),
          idParams()
        ),
    },
    {
      name: "DELETE /integrations/connections/{id}",
      call: () =>
        deleteConnection(request("DELETE", `/${CONNECTION_ID}`), idParams()),
    },
    {
      name: "POST /integrations/connections/{id}/test",
      call: () =>
        testConnection(request("POST", `/${CONNECTION_ID}/test`), idParams()),
    },
    {
      name: "GET /integrations/connections/{id}/inbound",
      call: () =>
        getInbound(request("GET", `/${CONNECTION_ID}/inbound`), idParams()),
    },
    {
      name: "POST /integrations/connections/{id}/inbound/rotate",
      call: () =>
        rotateInbound(
          request("POST", `/${CONNECTION_ID}/inbound/rotate`),
          idParams()
        ),
    },
  ];

  it.each(adminOnly)("$name returns 403 for a non-admin", async ({ call }) => {
    asMember();

    const response = await call();

    expect(response.status).toBe(403);
    expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
      "auth-org-1",
      "auth-user-1"
    );
    for (const method of Object.values(mocks.service)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each(adminOnly)("$name fails closed when the role lookup fails", async ({
    call,
  }) => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "provider_error",
    });

    const response = await call();

    expect(response.status).toBe(403);
  });
});

describe("mutations as an admin", () => {
  beforeEach(asAdmin);

  it("creates a connection from a validated body", async () => {
    mocks.service.create.mockResolvedValue({ ok: true, value: CONNECTION });

    const response = await createConnection(
      request("POST", "", {
        provider: IntegrationProviderKey.Jira,
        name: "  Jira Cloud  ",
        config: { siteUrl: "https://example.atlassian.net" },
        secrets: { apiToken: "token" },
      }),
      noParams()
    );

    expect(response.status).toBe(200);
    expect(mocks.service.create).toHaveBeenCalledWith("org-1", "user-1", {
      provider: IntegrationProviderKey.Jira,
      name: "Jira Cloud",
      config: { siteUrl: "https://example.atlassian.net" },
      secrets: { apiToken: "token" },
      deliveryMode: IntegrationDeliveryMode.None,
      pollIntervalSeconds: 120,
    });
    expect((await response.json()).data.id).toBe(CONNECTION_ID);
  });

  it("rejects an invalid body without calling the service", async () => {
    const response = await createConnection(
      request("POST", "", { provider: IntegrationProviderKey.Jira, name: "" }),
      noParams()
    );

    expect(response.status).toBe(400);
    expect(mocks.service.create).not.toHaveBeenCalled();
  });

  it("passes the provider's validation message through as a 400", async () => {
    mocks.service.create.mockResolvedValue({
      ok: false,
      error: {
        status: Status.BadRequest,
        message: "Jira rejected the API token",
      },
    });

    const response = await createConnection(
      request("POST", "", {
        provider: IntegrationProviderKey.Jira,
        name: "Jira",
      }),
      noParams()
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Jira rejected the API token");
  });

  it("maps update errors to their status", async () => {
    mocks.service.update.mockResolvedValue({
      ok: false,
      error: {
        status: Status.NotFound,
        message: "Integration connection not found",
      },
    });

    const response = await patchConnection(
      request("PATCH", `/${CONNECTION_ID}`, {
        status: IntegrationConnectionStatus.Disabled,
      }),
      idParams()
    );

    expect(response.status).toBe(404);
    expect(mocks.service.update).toHaveBeenCalledWith("org-1", CONNECTION_ID, {
      status: IntegrationConnectionStatus.Disabled,
    });
  });

  it("forwards only the fields the client sent, not the schema defaults", async () => {
    mocks.service.update.mockResolvedValue({ ok: true, value: CONNECTION });

    const response = await patchConnection(
      request("PATCH", `/${CONNECTION_ID}`, {
        deliveryMode: IntegrationDeliveryMode.Poll,
        pollIntervalSeconds: 300,
        secrets: { apiToken: null },
      }),
      idParams()
    );

    expect(response.status).toBe(200);
    expect(mocks.service.update).toHaveBeenCalledWith("org-1", CONNECTION_ID, {
      deliveryMode: IntegrationDeliveryMode.Poll,
      pollIntervalSeconds: 300,
      secrets: { apiToken: null },
    });
  });

  it("rejects a status other than active or disabled", async () => {
    const response = await patchConnection(
      request("PATCH", `/${CONNECTION_ID}`, {
        status: IntegrationConnectionStatus.Error,
      }),
      idParams()
    );

    expect(response.status).toBe(400);
    expect(mocks.service.update).not.toHaveBeenCalled();
  });

  it("deletes, or answers 409 while the connection is in use", async () => {
    mocks.service.remove
      .mockResolvedValueOnce({ ok: true, value: { deleted: true } })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          status: Status.Conflict,
          message: "The connection is used by 1 workflow",
        },
      });

    const deleted = await deleteConnection(
      request("DELETE", `/${CONNECTION_ID}`),
      idParams()
    );
    const conflict = await deleteConnection(
      request("DELETE", `/${CONNECTION_ID}`),
      idParams()
    );

    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toEqual({ deleted: true });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe(
      "The connection is used by 1 workflow"
    );
  });

  it("tests a connection and reports a failed check as a 200", async () => {
    mocks.service.test.mockResolvedValue({
      ok: false,
      account: null,
      error: "401 Unauthorized",
    });

    const response = await testConnection(
      request("POST", `/${CONNECTION_ID}/test`),
      idParams()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      ok: false,
      account: null,
      error: "401 Unauthorized",
    });
  });

  it("returns and rotates the inbound details, or 404", async () => {
    mocks.service.getInboundDetails.mockResolvedValue(INBOUND_DETAILS);
    mocks.service.rotateInbound.mockResolvedValue(null);

    const details = await getInbound(
      request("GET", `/${CONNECTION_ID}/inbound`),
      idParams()
    );
    const rotated = await rotateInbound(
      request("POST", `/${CONNECTION_ID}/inbound/rotate`),
      idParams()
    );

    expect(details.status).toBe(200);
    expect((await details.json()).data).toEqual(INBOUND_DETAILS);
    expect(rotated.status).toBe(404);
  });

  it("answers 500 with a generic message when the service throws", async () => {
    mocks.service.getInboundDetails.mockRejectedValue(
      new Error("The inbound secret could not be decrypted")
    );

    const response = await getInbound(
      request("GET", `/${CONNECTION_ID}/inbound`),
      idParams()
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      "Failed to load inbound details"
    );
  });
});
