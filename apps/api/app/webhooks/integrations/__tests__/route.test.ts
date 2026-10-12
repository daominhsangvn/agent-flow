import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOUND_TOKEN_HEADER,
  verifyStaticToken,
} from "@/lib/integrations/inbound-auth";
import type { InboundRequest } from "@/lib/integrations/types";

const mocks = vi.hoisted(() => ({
  loadConnectionByInboundKey: vi.fn(),
  ingestEvents: vi.fn(),
  parse: vi.fn(),
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionByInboundKey: mocks.loadConnectionByInboundKey,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/workflows/engine/ingest", () => ({
  ingestEvents: mocks.ingestEvents,
  toDeliveryPayload: (body: string) => ({ body }),
}));
vi.mock("@/lib/route-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/route-utils")>();
  return { ...original, scheduleLogFlush: mocks.scheduleLogFlush };
});

import { POST } from "@/app/webhooks/integrations/[inboundKey]/route";

const INBOUND_KEY = "inbound_key_abcdefghijklmnop";
const INBOUND_SECRET = "inbound-secret-value";
const BODY = JSON.stringify({ webhookEvent: "jira:issue_updated" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConnectionByInboundKey.mockResolvedValue(connection());
  mocks.parse.mockResolvedValue({
    deliveryId: "atl-delivery-1",
    eventType: "jira:issue_updated",
    events: [],
    ignoredReason: "Not assigned to the bot",
  });
  mocks.ingestEvents.mockResolvedValue({
    outcome: IntegrationDeliveryOutcome.Ignored,
    runCount: 0,
    deliveryRowId: "row-1",
    decisions: [],
    detail: "Not assigned to the bot",
  });
});

function connection(
  overrides: { status?: string; deliveryMode?: string } = {}
) {
  return {
    record: {
      id: "conn-1",
      organizationId: "org-1",
      provider: IntegrationProviderKey.Jira,
      status: overrides.status ?? IntegrationConnectionStatus.Active,
      deliveryMode: overrides.deliveryMode ?? IntegrationDeliveryMode.Webhook,
    },
    provider: {
      key: IntegrationProviderKey.Jira,
      inbound: {
        verify: (request: InboundRequest, context: { inboundSecret: string }) =>
          verifyStaticToken(request.headers, context.inboundSecret),
        parse: mocks.parse,
      },
    },
    runtime: {
      id: "conn-1",
      provider: IntegrationProviderKey.Jira,
      name: "Jira",
      config: {},
      account: null,
      secrets: {},
    },
    inboundSecret: INBOUND_SECRET,
  };
}

function request(
  options: { token?: string | null; body?: string; key?: string } = {}
) {
  const headers = new Headers({ "content-type": "application/json" });
  const token = options.token === undefined ? INBOUND_SECRET : options.token;
  if (token) {
    headers.set(INBOUND_TOKEN_HEADER, token);
  }
  const key = options.key ?? INBOUND_KEY;
  return {
    request: new Request(
      `https://api.example.test/webhooks/integrations/${key}`,
      {
        method: "POST",
        headers,
        body: options.body ?? BODY,
      }
    ),
    context: { params: Promise.resolve({ inboundKey: key }) },
  };
}

async function post(options?: Parameters<typeof request>[0]) {
  const { request: req, context } = request(options);
  const response = await POST(req, context);
  return { status: response.status, body: await response.json() };
}

describe("POST /webhooks/integrations/[inboundKey]", () => {
  it("answers 404 with a generic body for an unknown key", async () => {
    mocks.loadConnectionByInboundKey.mockResolvedValue(null);

    const response = await post();

    expect(response).toEqual({
      status: 404,
      body: { ok: false, message: "Not found" },
    });
    expect(mocks.ingestEvents).not.toHaveBeenCalled();
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("answers 401 when the token does not verify", async () => {
    const response = await post({ token: "wrong-token" });

    expect(response).toEqual({
      status: 401,
      body: { ok: false, message: "Unauthorized" },
    });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.ingestEvents).not.toHaveBeenCalled();
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("answers 401 without credentials", async () => {
    const response = await post({ token: null });

    expect(response.status).toBe(401);
  });

  it("verifies, parses and ingests a delivery, then answers 200", async () => {
    const response = await post();

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.parse).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: BODY }),
      expect.anything()
    );
    expect(mocks.ingestEvents).toHaveBeenCalledWith({
      connection: expect.objectContaining({ inboundSecret: INBOUND_SECRET }),
      source: IntegrationDeliverySource.Webhook,
      deliveryId: "atl-delivery-1",
      eventType: "jira:issue_updated",
      events: [],
      payload: { body: BODY },
      ignoredReason: "Not assigned to the bot",
    });
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("acknowledges deliveries to a disabled connection without processing", async () => {
    mocks.loadConnectionByInboundKey.mockResolvedValue(
      connection({ status: IntegrationConnectionStatus.Disabled })
    );

    const response = await post({ token: null });

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.ingestEvents).not.toHaveBeenCalled();
  });

  it("acknowledges deliveries to a connection that is not in webhook mode", async () => {
    mocks.loadConnectionByInboundKey.mockResolvedValue(
      connection({ deliveryMode: IntegrationDeliveryMode.Poll })
    );

    const response = await post();

    expect(response.status).toBe(200);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("answers 400 when the provider cannot parse the payload", async () => {
    mocks.parse.mockRejectedValue(new Error("Unexpected token"));

    const response = await post();

    expect(response).toEqual({
      status: 400,
      body: { ok: false, message: "Invalid payload" },
    });
    expect(mocks.ingestEvents).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over 1 MB", async () => {
    const response = await post({ body: "x".repeat(1024 * 1024 + 1) });

    expect(response.status).toBe(413);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("answers 500 with a generic body when ingest fails", async () => {
    mocks.ingestEvents.mockRejectedValue(new Error("db down: secret detail"));

    const response = await post();

    expect(response).toEqual({
      status: 500,
      body: { ok: false, message: "Something went wrong" },
    });
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });
});
