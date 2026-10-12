import type { APIRequestContext } from "@playwright/test";
import {
  saveWorkflowInputSchema,
  type Workflow,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowRunsResponse,
} from "@repo/api/src/types/workflow";
import type { z } from "zod";
import { bearer, deleteQuietly, readApiResult } from "./api-result";
import { getApiBaseUrl } from "./api-url";
import { PollAbortError, pollUntil } from "./poll";

export type SaveWorkflowRequest = z.input<typeof saveWorkflowInputSchema>;

const RUN_POLL_INTERVAL_MS = 1000;

export async function createWorkflow(
  request: APIRequestContext,
  { input, token }: { input: SaveWorkflowRequest; token: string }
): Promise<Workflow> {
  const response = await request.post(`${getApiBaseUrl()}/workflows`, {
    data: saveWorkflowInputSchema.parse(input),
    headers: bearer(token),
  });
  return readApiResult<Workflow>(response, `Create workflow "${input.name}"`);
}

export async function deleteWorkflow(
  request: APIRequestContext,
  workflowId: string | null,
  token: string
): Promise<void> {
  if (!workflowId) {
    return;
  }
  await deleteQuietly(
    request,
    `${getApiBaseUrl()}/workflows/${workflowId}`,
    token
  );
}

/** Latest runs of one workflow (first page). */
export async function listWorkflowRuns(
  request: APIRequestContext,
  workflowId: string,
  token: string
): Promise<WorkflowRunSummary[]> {
  const response = await request.get(
    `${getApiBaseUrl()}/workflows/${workflowId}/runs`,
    { headers: bearer(token) }
  );
  const page = await readApiResult<WorkflowRunsResponse>(
    response,
    "List workflow runs"
  );
  return page.runs;
}

export async function getWorkflowRun(
  request: APIRequestContext,
  runId: string,
  token: string
): Promise<WorkflowRunDetail> {
  const response = await request.get(
    `${getApiBaseUrl()}/workflow-runs/${runId}`,
    { headers: bearer(token) }
  );
  return readApiResult<WorkflowRunDetail>(response, "Read workflow run");
}

/**
 * Polls the workflow's runs until one reaches `status`. Fails fast when a run
 * reaches a different final status instead of waiting out the timeout.
 */
export async function waitForWorkflowRunStatus(
  request: APIRequestContext,
  {
    workflowId,
    status,
    finalStatuses,
    token,
    timeoutMs,
  }: {
    workflowId: string;
    status: WorkflowRunStatus;
    finalStatuses: readonly WorkflowRunStatus[];
    token: string;
    timeoutMs: number;
  }
): Promise<WorkflowRunSummary> {
  let lastSeen: WorkflowRunSummary[] = [];
  return await pollUntil(
    async () => {
      lastSeen = await listWorkflowRuns(request, workflowId, token);
      const match = lastSeen.find((run) => run.status === status);
      if (match) {
        return match;
      }
      const unexpected = lastSeen.find((run) =>
        finalStatuses.includes(run.status)
      );
      if (unexpected) {
        throw new PollAbortError(
          `Workflow run ${unexpected.id} ended with status "${unexpected.status}" instead of "${status}" (error: ${JSON.stringify(unexpected.error)})`
        );
      }
      return null;
    },
    {
      description: `a run of workflow ${workflowId} with status "${status}"`,
      timeoutMs,
      intervalMs: RUN_POLL_INTERVAL_MS,
      describeLastAttempt: () => describeRuns(lastSeen),
    }
  );
}

function describeRuns(runs: readonly WorkflowRunSummary[]): string {
  if (runs.length === 0) {
    return "no runs";
  }
  return runs
    .map(
      (run) =>
        `${run.id}=${run.status}${run.error ? ` (${run.error.code}: ${run.error.message})` : ""}`
    )
    .join(", ");
}
