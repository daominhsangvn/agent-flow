import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/telemetry-utils", () => ({ safeEmit: vi.fn() }));

const TARGET_ID = "target-1";

function operation(operationId: string): RelayOperationDispatchRequest {
  return {
    operationId,
    operation: "symphony_loop",
    params: {},
    streaming: false,
  };
}

// The self-hosted server loads the bus once through tsx (desktop gateway
// socket server) and once inside the Next.js route bundle, in one process.
async function loadIndependentBusInstance() {
  vi.resetModules();
  const module = await import("../relay-event-bus");
  return module.relayEventBus;
}

describe("relay event bus shared across module instances", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("delivers an operation published by one copy to a subscriber of another", async () => {
    const socketServerBus = await loadIndependentBusInstance();
    const routeBus = await loadIndependentBusInstance();
    expect(routeBus).not.toBe(socketServerBus);

    const received: string[] = [];
    const unsubscribe = socketServerBus.subscribeOperations(
      TARGET_ID,
      (delivered) => received.push(delivered.operationId)
    );
    try {
      const outcome = routeBus.publishOperation(TARGET_ID, operation("op-1"));
      expect(outcome).toEqual({ deliveredToSubscriber: true });
      expect(received).toEqual(["op-1"]);
    } finally {
      unsubscribe();
    }
  });

  it("drains an operation queued by one copy when another copy subscribes", async () => {
    const routeBus = await loadIndependentBusInstance();
    routeBus.publishOperation(TARGET_ID, operation("queued-op"));

    const socketServerBus = await loadIndependentBusInstance();
    const received: string[] = [];
    const unsubscribe = socketServerBus.subscribeOperations(
      TARGET_ID,
      (delivered) => received.push(delivered.operationId)
    );
    unsubscribe();
    expect(received).toEqual(["queued-op"]);
  });
});
