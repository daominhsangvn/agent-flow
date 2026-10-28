/**
 * How a settled loop is priced: Claude Code's own cost when the runner sent
 * it, and `apiKeySource: "none"` read as a subscription only on a compute
 * target without a model provider (a header-authenticated proxy reports
 * "none" too, yet bills per token).
 */

import {
  LoopReconciliationStatus,
  LoopSessionOrigin,
} from "@agentflow-ai/loops-api/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

vi.mock("@/app/documents/document-service", () => ({
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/documents/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByDocument: vi.fn().mockResolvedValue([]),
  },
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

const { mockIsInvalidStatusTransitionError } = vi.hoisted(() => ({
  mockIsInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(undefined),
    persistLaunchInfo: vi.fn(),
  },
}));

vi.mock("@/app/loops/loop-errors", () => ({
  isInvalidStatusTransitionError: mockIsInvalidStatusTransitionError,
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

const { mockResolveComputeTargetClaudeRuntime } = vi.hoisted(() => ({
  mockResolveComputeTargetClaudeRuntime: vi.fn(),
}));

vi.mock("@/app/compute-targets/model-provider-service", () => ({
  resolveComputeTargetClaudeRuntime: mockResolveComputeTargetClaudeRuntime,
}));

/** A compute target whose loops run through a header-authenticated proxy. */
const MODEL_PROVIDER_RUNTIME = {
  claudeEnv: {
    ANTHROPIC_BASE_URL: "https://claude-proxy.example.com",
    ANTHROPIC_CUSTOM_HEADERS: "X-Api-Key: test-key",
  },
  claudeCodeVersion: "latest",
};

vi.mock("@repo/auth/loop-runner-jwt", async (importOriginal) => {
  const { createLoopRunnerJwtMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createLoopRunnerJwtMockModule(importOriginal);
});

const mockDownloadMetadata = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: (...args: unknown[]) => mockDownloadMetadata(...args),
  downloadArtifactFile: vi.fn().mockResolvedValue(null),
  downloadPromptSnapshotMarkdownEntries: vi.fn().mockResolvedValue([]),
  getStateKeyPrefix: vi.fn().mockReturnValue("org/loops/loop-1/run-1"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-url"),
  scrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: () => null,
  COMMAND_HANDLERS: {},
}));

// --- Imports (after mocks) ---

import { loopsService } from "@/app/loops/service";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
};

// ---------------------------------------------------------------------------

describe("loop pricing by billing source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveComputeTargetClaudeRuntime.mockReset();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  it("prices a FAILED loop whose apiKeySource is none when its compute target has a model provider", async () => {
    setupLoop({ computeTargetId: "target-1" });
    mockResolveComputeTargetClaudeRuntime.mockResolvedValue(
      MODEL_PROVIDER_RUNTIME
    );

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      apiKeySource: "none",
      tokenUsage: { inputTokens: 8000, outputTokens: 4000 },
    });

    const data = mockLoopsService.updateStatus.mock.calls[0][3] as {
      estimatedCost: number;
    };
    expect(mockResolveComputeTargetClaudeRuntime).toHaveBeenCalledWith(
      "target-1"
    );
    expect(data.estimatedCost).toBeGreaterThan(0);
  });

  it("prices a loop whose apiKeySource is none when its compute target has a model provider", async () => {
    setupLoop({ computeTargetId: "target-1" });
    mockResolveComputeTargetClaudeRuntime.mockResolvedValue(
      MODEL_PROVIDER_RUNTIME
    );

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 50_000, output: 30_000 },
      apiKeySource: "none",
      timestamp: new Date().toISOString(),
    });

    expect(mockResolveComputeTargetClaudeRuntime).toHaveBeenCalledWith(
      "target-1"
    );
    const data = mockLoopsService.updateStatus.mock.calls[0][3] as {
      estimatedCost: number;
    };
    expect(data.estimatedCost).toBeGreaterThan(0);
  });

  it("prices a loop at Claude Code's own cost when the runner reported it", async () => {
    setupLoop({ computeTargetId: "target-1" });
    mockResolveComputeTargetClaudeRuntime.mockResolvedValue(
      MODEL_PROVIDER_RUNTIME
    );

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 50_000, output: 30_000 },
      usageReconciliation: {
        sessionOrigin: LoopSessionOrigin.HarnessStdout,
        authoritativeCostUsd: 9.57,
        derivedCostUsd: 31.4,
        reconciliationStatus: LoopReconciliationStatus.Drifted,
        reconciliationDeltaUsd: 21.83,
        harnessNumTurns: 5,
        harnessDurationMs: 52_419,
      },
      apiKeySource: "none",
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({ estimatedCost: 9.57 })
    );
  });

  it.each([
    {
      name: "its compute target uses the machine's own account",
      arrange: () =>
        mockResolveComputeTargetClaudeRuntime.mockResolvedValue({
          ...MODEL_PROVIDER_RUNTIME,
          claudeEnv: null,
        }),
    },
    {
      name: "the model provider lookup fails (the loop still settles)",
      arrange: () =>
        mockResolveComputeTargetClaudeRuntime.mockRejectedValue(
          new Error("db unavailable")
        ),
    },
  ])("keeps a none-apiKeySource loop free when $name", async ({ arrange }) => {
    setupLoop({ computeTargetId: "target-1" });
    arrange();

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 50_000, output: 30_000 },
      apiKeySource: "none",
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({ estimatedCost: 0 })
    );
  });
});

function setupLoop(
  overrides: Partial<Parameters<typeof buildLoop>[0]> = {}
): void {
  mockLoopsService.findById.mockResolvedValue(
    buildLoop({
      command: "CHAT" as "PLAN",
      s3StateKey: null,
      documentId: null,
      status: "RUNNING",
      ...overrides,
    })
  );
  mockLoopsService.updateStatus.mockResolvedValue(undefined);
  mockLoopsService.addEvent.mockResolvedValue(undefined);
}
