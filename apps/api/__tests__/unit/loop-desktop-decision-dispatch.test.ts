/**
 * Workflow decision dispatch (`dispatchWorkflowDecision`): the API asks the
 * run's computer, unsigned like a workflow instruction, to answer one prompt
 * with its model and no tools (docs/workflows.md "PRD or Issue").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).logMock()
);

vi.mock("@repo/database", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).databaseMock()
);

vi.mock("@/lib/desktop-command-store", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopCommandStoreMock()
);

vi.mock("@/app/compute-targets/service", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).computeTargetsServiceMock()
);

vi.mock("@/lib/compute-target-signing-eligibility", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).commandSigningEligibilityMock()
);

vi.mock("@/lib/relay-event-bus", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayEventBusMock()
);

vi.mock("@/app/compute-targets/relay-command-helpers", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayCommandHelpersMock()
);

vi.mock("@/lib/desktop-gateway-wire", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopGatewayWireMock()
);

vi.mock("@/app/compute-targets/model-provider-service", () => ({
  resolveComputeTargetClaudeRuntime: vi.fn().mockResolvedValue({
    claudeEnv: { ANTHROPIC_BASE_URL: "https://claude-proxy.test" },
    claudeCodeVersion: "latest",
  }),
}));

// --- Imports (after mocks) ---

import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
} from "@repo/api/src/types/compute-target";
import {
  WORKFLOW_DECISION_GATEWAY_PATH,
  WORKFLOW_DECISION_OPERATION_ID,
  WORKFLOW_DECISION_TIMEOUT_MS,
} from "@repo/api/src/types/workflow-decision";
import { stubDefaultCreateCommand } from "@/__tests__/support/loops/loop-desktop-dispatch.test-helpers";
import {
  DEFAULT_COMMAND_ID,
  mockResponse,
} from "@/__tests__/support/loops/loop-desktop-dispatch.test-mocks";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  DispatchError,
  dispatchWorkflowDecision,
} from "@/lib/loops/loop-desktop";

const REQUEST = {
  decisionId: "0199a5f0-0000-7000-8000-0000000000a1",
  prompt: "Is this item a PRD?",
};

describe("dispatchWorkflowDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDefaultCreateCommand();
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("delivers an unsigned streaming decision with the computer's Claude settings", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await expect(
      dispatchWorkflowDecision({ computeTargetId: "ct-1", request: REQUEST })
    ).resolves.toBe(DEFAULT_COMMAND_ID);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith("ct-1", {
      operationId: WORKFLOW_DECISION_OPERATION_ID,
      method: "POST",
      path: WORKFLOW_DECISION_GATEWAY_PATH,
      body: {
        ...REQUEST,
        claudeEnv: { ANTHROPIC_BASE_URL: "https://claude-proxy.test" },
        claudeCodeVersion: "latest",
      },
      timeoutMs: WORKFLOW_DECISION_TIMEOUT_MS + 60_000,
      streaming: true,
    });
  });

  it("throws a DispatchError when the relay did not deliver it", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(
      dispatchWorkflowDecision({ computeTargetId: "ct-1", request: REQUEST })
    ).rejects.toThrow(DispatchError);
  });

  it("refuses a computer that only takes commands signed in a browser", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
      user: { clerkId: "clerk-owner-1" },
    } as unknown as Awaited<ReturnType<typeof computeTargetsService.findById>>);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Eligible,
    });

    await expect(
      dispatchWorkflowDecision({ computeTargetId: "ct-1", request: REQUEST })
    ).rejects.toThrow("cannot answer workflow decisions");
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });
});
