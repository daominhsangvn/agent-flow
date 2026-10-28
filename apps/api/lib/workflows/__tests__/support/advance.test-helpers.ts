import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  LoopCommand,
  LoopEventType,
  LoopStatus,
} from "@repo/api/src/types/loop";
import { type Mock, vi } from "vitest";
import type { FakeLoopEvent } from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";

/**
 * Builders shared by the advance.ts suites: run loop rows as
 * workflow_run_loops would hold them, the connection runtime the ingesting
 * step fetches the source item with, and the reaper's TIMED_OUT loop event.
 */

/** The advance time the suites pass to advanceRun. */
export const NOW = new Date("2026-10-01T01:00:00.000Z");
/** Secret of the connection; it must never reach a run error. */
export const SOURCE_TOKEN = "jira-api-token-123456";
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function runLoopState(
  overrides: Partial<RunLoopState> = {}
): RunLoopState {
  return {
    loopId: "loop-1",
    command: LoopCommand.Plan,
    adopted: false,
    stepId: null,
    linkedAt: NOW,
    status: LoopStatus.Running,
    computeTargetId: "ct-1",
    prUrl: null,
    prNumber: null,
    branchName: null,
    error: null,
    uploadedArtifacts: null,
    revivalCount: 0,
    sessionId: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

/** The reaper's TIMED_OUT error event for a loop (reaper-helpers.ts shape). */
export function reaperTimeoutEvent(
  loopId: string,
  reason: string,
  createdAt = NOW
): FakeLoopEvent {
  return {
    loopId,
    type: LoopEventType.Error,
    data: { code: "TIMED_OUT", message: "stale", reaper: { reason } },
    createdAt,
  };
}

/** A Jira connection runtime whose fetchItem resolves PROJ-7. */
export function connectionWithItem(fetchItem: Mock = vi.fn()) {
  fetchItem.mockResolvedValue({
    provider: IntegrationProviderKey.Jira,
    externalId: "1",
    key: "PROJ-7",
    url: null,
    title: "Add CSV export",
    container: null,
    bodyMarkdown: "body",
    itemType: null,
    status: null,
    priority: null,
    labels: [],
    reporter: null,
    assignee: null,
    sections: [],
    comments: [],
    attachments: [],
  });
  return {
    record: { id: "c-1" },
    provider: {
      key: IntegrationProviderKey.Jira,
      displayName: "Jira",
      source: { fetchItem },
    },
    runtime: { id: "c-1", secrets: { apiToken: SOURCE_TOKEN } },
  };
}
