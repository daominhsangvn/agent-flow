import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvent,
  buildLoadedConnection,
} from "@/lib/workflows/__tests__/support/ingest-db.test-fake";
import {
  POLL_BATCH_LIMIT,
  pollDueConnections,
} from "@/lib/workflows/engine/poll";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  recordConnectionPollResult: vi.fn(),
  ingestEvents: vi.fn(),
  poll: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      integrationConnection: {
        findMany: mocks.findMany,
        updateMany: mocks.updateMany,
      },
    }),
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
  recordConnectionPollResult: mocks.recordConnectionPollResult,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/workflows/engine/ingest", () => ({
  ingestEvents: mocks.ingestEvents,
  toDeliveryPayload: (value: unknown) => ({ value: String(value) }),
}));

const NOW = new Date("2026-10-01T12:00:00.000Z");
const SECRET = "ado-pat-secret-0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([
    {
      id: "conn-1",
      organizationId: "org-1",
      pollIntervalSeconds: 120,
      pollCursor: { since: "2026-10-01T11:58:00.000Z" },
    },
  ]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.loadConnectionRuntime.mockResolvedValue(loadedWithPoll());
  mocks.poll.mockResolvedValue({
    events: [buildEvent(), buildEvent({ dedupKey: "PROJ-8:assignee:5" })],
    cursor: { since: NOW.toISOString() },
  });
  mocks.ingestEvents.mockResolvedValue({
    outcome: IntegrationDeliveryOutcome.Accepted,
    runCount: 1,
  });
});

function loadedWithPoll() {
  const loaded = buildLoadedConnection();
  return {
    ...loaded,
    provider: { ...loaded.provider, inbound: { poll: mocks.poll } },
    runtime: { ...loaded.runtime, secrets: { pat: SECRET } },
  };
}

describe("pollDueConnections", () => {
  it("selects due, non-disabled polling connections", async () => {
    await pollDueConnections(NOW);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryMode: IntegrationDeliveryMode.Poll,
          status: { not: IntegrationConnectionStatus.Disabled },
          nextPollAt: { lte: NOW },
        },
        take: POLL_BATCH_LIMIT,
      })
    );
  });

  it("claims the poll, ingests each event as its own delivery and saves the cursor", async () => {
    const summary = await pollDueConnections(NOW);

    const nextPollAt = new Date(NOW.getTime() + 120_000);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "conn-1", nextPollAt: { lte: NOW } },
      data: { nextPollAt },
    });
    expect(mocks.poll).toHaveBeenCalledWith(expect.anything(), {
      since: "2026-10-01T11:58:00.000Z",
    });
    expect(mocks.ingestEvents).toHaveBeenCalledTimes(2);
    expect(mocks.ingestEvents.mock.calls[0][0]).toMatchObject({
      source: IntegrationDeliverySource.Poll,
      deliveryId: "poll:PROJ-7:assignee:100",
      events: [expect.objectContaining({ dedupKey: "PROJ-7:assignee:100" })],
    });
    expect(mocks.recordConnectionPollResult).toHaveBeenCalledWith("conn-1", {
      cursor: { since: NOW.toISOString() },
      error: null,
      nextPollAt,
    });
    expect(summary).toEqual({ polled: 1, failed: 0, events: 2, runs: 2 });
  });

  it("records a failed poll without moving the cursor", async () => {
    mocks.poll.mockRejectedValue(new Error(`401 with ${SECRET}`));

    const summary = await pollDueConnections(NOW);

    const [, result] = mocks.recordConnectionPollResult.mock.calls[0];
    expect(result).not.toHaveProperty("cursor");
    expect(result.error).toContain("401");
    expect(result.error).not.toContain(SECRET);
    expect(result.nextPollAt).toEqual(new Date(NOW.getTime() + 120_000));
    expect(summary).toMatchObject({ polled: 1, failed: 1 });
  });

  it("skips a connection another worker already claimed", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const summary = await pollDueConnections(NOW);

    expect(mocks.poll).not.toHaveBeenCalled();
    expect(summary.polled).toBe(0);
  });

  it("records an error when the connection cannot be loaded", async () => {
    mocks.loadConnectionRuntime.mockResolvedValue(null);

    const summary = await pollDueConnections(NOW);

    expect(mocks.recordConnectionPollResult).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(summary.failed).toBe(1);
  });

  it("passes a null cursor on the first poll", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "conn-1",
        organizationId: "org-1",
        pollIntervalSeconds: 60,
        pollCursor: null,
      },
    ]);

    await pollDueConnections(NOW);

    expect(mocks.poll).toHaveBeenCalledWith(expect.anything(), null);
  });
});
