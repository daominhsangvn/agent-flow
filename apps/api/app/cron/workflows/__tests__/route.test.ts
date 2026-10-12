import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runWorkflowTick: vi.fn(),
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
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mocks.scheduleLogFlush,
}));
vi.mock("@/lib/workflows/engine/tick", () => ({
  runWorkflowTick: mocks.runWorkflowTick,
}));

import { GET } from "@/app/cron/workflows/route";

const SECRET = "test-cron-secret";
const TICK = {
  poll: { polled: 1, failed: 0, events: 2, runs: 1 },
  runs: { checked: 3, advanced: 3 },
  actionRuns: {
    claimed: 1,
    succeeded: 1,
    skipped: 0,
    retried: 0,
    failed: 0,
    requeued: 0,
  },
  errors: [],
  durationMs: 12,
};

function request(authorization?: string): Request {
  return new Request("http://127.0.0.1:3002/cron/workflows", {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /cron/workflows", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    mocks.runWorkflowTick.mockResolvedValue(TICK);
  });
  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("rejects a request without the bearer secret", async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.runWorkflowTick).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const response = await GET(request("Bearer not-the-secret"));

    expect(response.status).toBe(401);
    expect(mocks.runWorkflowTick).not.toHaveBeenCalled();
  });

  it("refuses to run when CRON_SECRET is not configured", async () => {
    process.env.CRON_SECRET = "";

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    expect(mocks.runWorkflowTick).not.toHaveBeenCalled();
  });

  it("runs one tick and returns its counts", async () => {
    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ...TICK });
    expect(mocks.runWorkflowTick).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleLogFlush).toHaveBeenCalled();
  });

  it("answers 500 with a generic body when the tick throws", async () => {
    mocks.runWorkflowTick.mockRejectedValue(new Error("db down"));

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Something went wrong",
    });
  });
});
