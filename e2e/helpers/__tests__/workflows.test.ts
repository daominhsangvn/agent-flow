import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  WORKFLOW_RUN_FINAL_STATUSES,
  WorkflowRunStatus,
  type WorkflowRunSummary,
} from "@repo/api/src/types/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForWorkflowRunStatus } from "../workflows";

const WORKFLOW_ID = "0199a0b0-0000-7000-8000-000000000001";
const RE_ENDED_SUCCEEDED = /ended with status "succeeded" instead of "failed"/;
const RE_TIMED_OUT = /Timed out .* Last attempt: run-1=planning/;

describe("waitForWorkflowRunStatus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the run once it reaches the awaited status", async () => {
    vi.stubEnv("E2E_API_URL", "http://localhost:3002");
    const request = fakeRequest([
      [run(WorkflowRunStatus.Received)],
      [run(WorkflowRunStatus.Ingesting)],
      [run(WorkflowRunStatus.Failed)],
    ]);

    const found = await waitForWorkflowRunStatus(request.context, {
      workflowId: WORKFLOW_ID,
      status: WorkflowRunStatus.Failed,
      finalStatuses: WORKFLOW_RUN_FINAL_STATUSES,
      token: "jwt",
      timeoutMs: 10_000,
    });

    expect(found.status).toBe(WorkflowRunStatus.Failed);
    expect(request.urls[0]).toBe(
      `http://localhost:3002/workflows/${WORKFLOW_ID}/runs`
    );
    expect(request.authorization).toBe("Bearer jwt");
  });

  it("fails fast when the run ends in another final status", async () => {
    vi.stubEnv("E2E_API_URL", "http://localhost:3002");
    const request = fakeRequest([[run(WorkflowRunStatus.Succeeded)]]);

    await expect(
      waitForWorkflowRunStatus(request.context, {
        workflowId: WORKFLOW_ID,
        status: WorkflowRunStatus.Failed,
        finalStatuses: WORKFLOW_RUN_FINAL_STATUSES,
        token: "jwt",
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(RE_ENDED_SUCCEEDED);
    expect(request.urls).toHaveLength(1);
  });

  it("reports the last statuses seen on timeout", async () => {
    vi.stubEnv("E2E_API_URL", "http://localhost:3002");
    const request = fakeRequest([[run(WorkflowRunStatus.Planning)]]);

    await expect(
      waitForWorkflowRunStatus(request.context, {
        workflowId: WORKFLOW_ID,
        status: WorkflowRunStatus.Failed,
        finalStatuses: WORKFLOW_RUN_FINAL_STATUSES,
        token: "jwt",
        timeoutMs: 1,
      })
    ).rejects.toThrow(RE_TIMED_OUT);
  });
});

function run(status: WorkflowRunStatus): WorkflowRunSummary {
  const now = new Date();
  return {
    id: "run-1",
    workflowId: WORKFLOW_ID,
    workflowName: "E2E",
    triggerId: null,
    triggerType: null,
    status,
    source: {
      provider: "webhook",
      externalId: "item-1",
      key: "item-1",
      title: "E2E workflow item",
      url: null,
    },
    prUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/** Serves one page of runs per call, repeating the last page. */
function fakeRequest(pages: WorkflowRunSummary[][]) {
  const urls: string[] = [];
  const state = { authorization: null as string | null };
  const get = (url: string, options?: { headers?: Record<string, string> }) => {
    const runs = pages[Math.min(urls.length, pages.length - 1)];
    urls.push(url);
    state.authorization = options?.headers?.Authorization ?? null;
    const body = { success: true, data: { runs, nextCursor: null } };
    const response = {
      json: () => Promise.resolve(body),
      status: () => 200,
      statusText: () => "OK",
    } as unknown as APIResponse;
    return Promise.resolve(response);
  };
  return {
    context: { get } as unknown as APIRequestContext,
    urls,
    get authorization() {
      return state.authorization;
    },
  };
}
