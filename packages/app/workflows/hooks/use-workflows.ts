"use client";

import type {
  AnswerStepQuestionsInput,
  DecideStepApprovalInput,
} from "@repo/api/src/types/project-process";
import {
  type SaveWorkflowInput,
  type SetWorkflowEnabledInput,
  type StartWorkflowRunInput,
  WORKFLOW_RUN_FINAL_STATUSES,
  type Workflow,
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowRunsResponse,
  type WorkflowsResponse,
} from "@repo/api/src/types/workflow";
// Cross-slice: the integrations slice owns the server-message error handling
// shared by both slices' mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type InfiniteData,
  type UseQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { WorkflowMutationErrorTitle } from "../lib/workflow-labels";
import { type WorkflowRunListFilters, workflowKeys } from "./workflow-keys";

type QueryOptions<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

/** Run detail refresh while the run is still moving (loops take minutes). */
export const WORKFLOW_RUN_POLL_INTERVAL_MS = 5000;

/**
 * Run detail refresh once the run is final but post actions are still being
 * delivered: the final event's actions are queued as the run finishes, and a
 * failed delivery retries with a backoff of 30 s and more.
 */
export const WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS = 15_000;

/** Run history refresh while any listed run is still active. */
export const WORKFLOW_RUN_LIST_POLL_INTERVAL_MS = 15_000;

/** Page size of the run history tables. */
export const WORKFLOW_RUNS_PAGE_SIZE = 25;

// Queries

export function useWorkflows(options?: QueryOptions<Workflow[]>) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workflowKeys.lists(),
    queryFn: async () => {
      const response = await apiClient.get<WorkflowsResponse>("/workflows");
      return response.workflows;
    },
    ...options,
  });
}

export function useWorkflow(id: string, options?: QueryOptions<Workflow>) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workflowKeys.detail(id),
    queryFn: () => apiClient.get<Workflow>(workflowPath(id)),
    enabled: !!id,
    ...options,
  });
}

/** Run history of one workflow, newest first, paged by cursor. */
export function useWorkflowRuns(
  workflowId: string,
  filters: WorkflowRunListFilters = {}
) {
  const apiClient = useApiClient();
  const normalized = normalizeRunFilters(filters);

  return useInfiniteQuery({
    queryKey: workflowKeys.workflowRuns(workflowId, normalized),
    queryFn: ({ pageParam }) =>
      apiClient.get<WorkflowRunsResponse>(
        `${workflowPath(workflowId)}/runs${buildRunListQuery(normalized, pageParam)}`
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!workflowId,
    refetchInterval: runListRefetchInterval,
  });
}

/** Run history across every workflow of the org, newest first, paged by cursor. */
export function useOrgWorkflowRuns(filters: WorkflowRunListFilters = {}) {
  const apiClient = useApiClient();
  const normalized = normalizeRunFilters(filters);

  return useInfiniteQuery({
    queryKey: workflowKeys.orgRuns(normalized),
    queryFn: ({ pageParam }) =>
      apiClient.get<WorkflowRunsResponse>(
        `/workflow-runs${buildRunListQuery(normalized, pageParam)}`
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: runListRefetchInterval,
  });
}

/**
 * One run with its loops and pre/post action runs. Polls while the run can
 * still change, then more slowly while a final run still has action runs
 * pending or running (the post actions of the final event, a retry). Stops
 * once everything is settled, and on a read error, so a missing run never
 * turns into an endless retry loop.
 */
export function useWorkflowRun(runId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workflowKeys.runDetail(runId),
    queryFn: () => apiClient.get<WorkflowRunDetail>(runPath(runId)),
    enabled: !!runId,
    refetchInterval: runDetailRefetchInterval,
  });
}

// Mutations
//
// Every mutation below toasts the server's message on failure (see
// `mutationErrorOptions`); the editor and the dialogs also show it inline.

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: SaveWorkflowInput) =>
      apiClient.post<Workflow>("/workflows", input),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflow.id), workflow);
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.Create),
  });
}

export type UpdateWorkflowVariables = {
  id: string;
  input: SaveWorkflowInput;
};

export function useUpdateWorkflow() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, input }: UpdateWorkflowVariables) =>
      apiClient.put<Workflow>(workflowPath(id), input),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflow.id), workflow);
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.Update),
  });
}

export type SetWorkflowEnabledVariables = {
  id: string;
  input: SetWorkflowEnabledInput;
};

/**
 * Turns a workflow on or off without re-sending it (`PATCH /workflows/{id}`),
 * so a workflow whose connection, run-as user or compute target broke can
 * still be paused. Used by the list switch and the editor's enabled switch.
 */
export function useSetWorkflowEnabled() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, input }: SetWorkflowEnabledVariables) =>
      apiClient.patch<Workflow>(workflowPath(id), input),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflow.id), workflow);
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.SetEnabled),
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(workflowPath(id)),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: workflowKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      queryClient.invalidateQueries({ queryKey: workflowKeys.runs() });
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.Delete),
  });
}

export type StartWorkflowRunVariables = {
  workflowId: string;
  input: StartWorkflowRunInput;
};

/** Starts a run by hand for one trigger (e.g. with a Jira issue key). */
export function useStartWorkflowRun() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ workflowId, input }: StartWorkflowRunVariables) =>
      apiClient.post<WorkflowRunSummary>(
        `${workflowPath(workflowId)}/runs`,
        input
      ),
    onSuccess: (_run, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.runs() });
      queryClient.invalidateQueries({
        queryKey: workflowKeys.detail(workflowId),
      });
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.StartRun),
  });
}

/** Cancels a run and its active loops. */
export function useCancelWorkflowRun() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (runId: string) =>
      apiClient.post<WorkflowRunDetail>(`${runPath(runId)}/cancel`, {}),
    onSuccess: (run) => {
      refreshRunCaches(queryClient, run);
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.CancelRun),
  });
}

export type RetryWorkflowActionRunVariables = {
  runId: string;
  actionRunId: string;
};

/**
 * Puts a failed or skipped post-action run back in the outbox. The server
 * delivers it in the background, so the run detail is refetched (and keeps
 * polling while the row is pending) to show the outcome.
 */
export function useRetryWorkflowActionRun() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ runId, actionRunId }: RetryWorkflowActionRunVariables) =>
      apiClient.post<WorkflowRunDetail>(
        `${runPath(runId)}/action-runs/${encodeURIComponent(actionRunId)}/retry`,
        {}
      ),
    onSuccess: (run) => {
      refreshRunCaches(queryClient, run);
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.RetryActionRun),
  });
}

export type AnswerWorkflowRunQuestionsVariables = {
  runId: string;
  input: AnswerStepQuestionsInput;
};

/**
 * Answers the questions of the process step a run waits on; the step resumes
 * its agent session with them in the background.
 */
export function useAnswerWorkflowRunQuestions() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ runId, input }: AnswerWorkflowRunQuestionsVariables) =>
      apiClient.post<WorkflowRunDetail>(`${runPath(runId)}/answers`, input),
    onSuccess: (run) => {
      refreshRunCaches(queryClient, run);
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.AnswerQuestions),
  });
}

export type DecideWorkflowRunApprovalVariables = {
  runId: string;
  input: DecideStepApprovalInput;
};

/** Approves or rejects the approval step a run waits on (org admins). */
export function useDecideWorkflowRunApproval() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ runId, input }: DecideWorkflowRunApprovalVariables) =>
      apiClient.post<WorkflowRunDetail>(`${runPath(runId)}/approval`, input),
    onSuccess: (run) => {
      refreshRunCaches(queryClient, run);
    },
    ...mutationErrorOptions(WorkflowMutationErrorTitle.DecideApproval),
  });
}

export function isFinalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return WORKFLOW_RUN_FINAL_STATUSES.includes(status);
}

/** Flattens the loaded pages of a run history query. */
export function flattenRunPages(
  data: InfiniteData<WorkflowRunsResponse> | undefined
): WorkflowRunSummary[] {
  return data?.pages.flatMap((page) => page.runs) ?? [];
}

function runDetailRefetchInterval(
  query: PolledQuery<WorkflowRunDetail>
): number | false {
  if (query.state.status === "error") {
    return false;
  }
  const run = query.state.data;
  if (!(run && isFinalWorkflowRunStatus(run.status))) {
    return WORKFLOW_RUN_POLL_INTERVAL_MS;
  }
  return hasUnsettledActionRuns(run.actionRuns)
    ? WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS
    : false;
}

/** Whether an action run is still waiting for (or in) a delivery attempt. */
function hasUnsettledActionRuns(
  actionRuns: readonly WorkflowActionRun[]
): boolean {
  return actionRuns.some(
    (actionRun) =>
      actionRun.status === WorkflowActionRunStatus.Pending ||
      actionRun.status === WorkflowActionRunStatus.Running
  );
}

function runListRefetchInterval(
  query: PolledQuery<InfiniteData<WorkflowRunsResponse>>
): number | false {
  if (query.state.status === "error") {
    return false;
  }
  const hasActiveRun = flattenRunPages(query.state.data).some(
    (run) => !isFinalWorkflowRunStatus(run.status)
  );
  return hasActiveRun ? WORKFLOW_RUN_LIST_POLL_INTERVAL_MS : false;
}

/**
 * After a cancel or a retry: show the returned detail right away, then
 * refetch it (the server keeps working in the background) and the lists.
 */
function refreshRunCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  run: WorkflowRunDetail
): void {
  queryClient.setQueryData(workflowKeys.runDetail(run.id), run);
  queryClient.invalidateQueries({ queryKey: workflowKeys.runDetail(run.id) });
  invalidateRunLists(queryClient, run.workflowId);
}

function invalidateRunLists(
  queryClient: ReturnType<typeof useQueryClient>,
  workflowId: string
): void {
  queryClient.invalidateQueries({
    queryKey: [...workflowKeys.runs(), "workflow", workflowId],
  });
  queryClient.invalidateQueries({
    queryKey: [...workflowKeys.runs(), "org"],
  });
  queryClient.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
  queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
}

function normalizeRunFilters(
  filters: WorkflowRunListFilters
): WorkflowRunListFilters {
  const normalized: WorkflowRunListFilters = {
    limit: filters.limit ?? WORKFLOW_RUNS_PAGE_SIZE,
  };
  if (filters.status) {
    normalized.status = filters.status;
  }
  return normalized;
}

function buildRunListQuery(
  filters: WorkflowRunListFilters,
  cursor: string | null
): string {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (filters.limit) {
    params.set("limit", String(filters.limit));
  }
  if (filters.status) {
    params.set("status", filters.status);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function workflowPath(id: string): string {
  return `/workflows/${encodeURIComponent(id)}`;
}

function runPath(runId: string): string {
  return `/workflow-runs/${encodeURIComponent(runId)}`;
}

/** The part of a TanStack `Query` the polling intervals read. */
type PolledQuery<TData> = {
  state: { status: "pending" | "error" | "success"; data: TData | undefined };
};
