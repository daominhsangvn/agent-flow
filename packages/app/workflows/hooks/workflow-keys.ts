import type { WorkflowRunStatus } from "@repo/api/src/types/workflow";

/** Filters of a run history list (per workflow or org-wide). */
export type WorkflowRunListFilters = {
  limit?: number;
  status?: WorkflowRunStatus;
};

/**
 * Query-key factory for event-driven workflows and their runs. Lives in its
 * own module so other slices can invalidate workflow caches without importing
 * the hooks.
 *
 * Every run read (per-workflow history, org-wide history, run detail) nests
 * under `runs()`, so one invalidation refreshes all run views after a manual
 * run, a cancel or a retry.
 */
export const workflowKeys = {
  all: ["workflows"] as const,
  lists: () => [...workflowKeys.all, "list"] as const,
  details: () => [...workflowKeys.all, "detail"] as const,
  detail: (id: string) => [...workflowKeys.details(), id] as const,
  runs: () => [...workflowKeys.all, "runs"] as const,
  workflowRuns: (workflowId: string, filters: WorkflowRunListFilters = {}) =>
    [...workflowKeys.runs(), "workflow", workflowId, filters] as const,
  orgRuns: (filters: WorkflowRunListFilters = {}) =>
    [...workflowKeys.runs(), "org", filters] as const,
  runDetails: () => [...workflowKeys.runs(), "detail"] as const,
  runDetail: (runId: string) => [...workflowKeys.runDetails(), runId] as const,
};
