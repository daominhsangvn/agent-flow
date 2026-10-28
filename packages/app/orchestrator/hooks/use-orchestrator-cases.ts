"use client";

import { LoopStatus } from "@repo/api/src/types/loop";
import type {
  DecideOrchestratorDecisionInput,
  OrchestratorCaseDetail,
  OrchestratorCaseLoops,
  OrchestratorCaseSummary,
  UpdateOrchestratorCaseInput,
} from "@repo/api/src/types/orchestrator";
import { isLiveDisplayedSessionStatus } from "@repo/api/src/types/session-status";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Orchestrator cases (docs/orchestrator.md): a workflow's case list, one
 * case with its conversations, and the admin actions on it.
 */

const CASE_POLL_INTERVAL_MS = 5000;

export const orchestratorCaseKeys = {
  all: ["orchestrator-cases"] as const,
  workflow: (workflowId: string) =>
    [...orchestratorCaseKeys.all, "workflow", workflowId] as const,
  detail: (caseId: string) =>
    [...orchestratorCaseKeys.all, "detail", caseId] as const,
  loops: (caseId: string) =>
    [...orchestratorCaseKeys.all, "loops", caseId] as const,
};

export function useWorkflowOrchestratorCases(
  workflowId: string,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: orchestratorCaseKeys.workflow(workflowId),
    queryFn: () =>
      apiClient.get<OrchestratorCaseSummary[]>(
        `/workflows/${encodeURIComponent(workflowId)}/cases`
      ),
    enabled: enabled && !!workflowId,
  });
}

export function useOrchestratorCase(caseId: string, enabled = true) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: orchestratorCaseKeys.detail(caseId),
    queryFn: () => apiClient.get<OrchestratorCaseDetail>(casePath(caseId)),
    enabled: enabled && !!caseId,
    refetchInterval: (query) =>
      isCaseActive(query.state.data) ? CASE_POLL_INTERVAL_MS : false,
  });
}

export function useOrchestratorCaseLoops(
  caseId: string,
  { poll = false }: { poll?: boolean } = {}
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: orchestratorCaseKeys.loops(caseId),
    queryFn: () =>
      apiClient.get<OrchestratorCaseLoops>(`${casePath(caseId)}/loops`),
    enabled: !!caseId,
    refetchInterval: (query) =>
      poll || hasLiveWork(query.state.data) ? CASE_POLL_INTERVAL_MS : false,
  });
}

const LIVE_LOOP_STATUSES: ReadonlySet<string> = new Set([
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
]);

/** Whether any returned loop or session is still going, so the data can still change. */
function hasLiveWork(data: OrchestratorCaseLoops | undefined): boolean {
  if (!data) {
    return false;
  }
  return (
    data.loops.some((loop) => LIVE_LOOP_STATUSES.has(loop.status)) ||
    data.sessions.some((session) =>
      isLiveDisplayedSessionStatus(session.status)
    )
  );
}

export function useSetOrchestratorCaseStatus(caseId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateOrchestratorCaseInput) =>
      apiClient.patch<{ status: UpdateOrchestratorCaseInput["status"] }>(
        casePath(caseId),
        input
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orchestratorCaseKeys.all }),
    ...mutationErrorOptions("Couldn't update the case"),
  });
}

export type DecideOrchestratorDecisionVariables = {
  decisionId: string;
  input: DecideOrchestratorDecisionInput;
};

export function useDecideOrchestratorDecision(_caseId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ decisionId, input }: DecideOrchestratorDecisionVariables) =>
      apiClient.post<unknown>(
        `/orchestrator/decisions/${encodeURIComponent(decisionId)}`,
        input
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orchestratorCaseKeys.all }),
    ...mutationErrorOptions("Couldn't record the decision"),
  });
}

export function useCancelOrchestratorTurn(_caseId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (turnId: string) =>
      apiClient.post<{ turnId: string }>(
        `/orchestrator/turns/${encodeURIComponent(turnId)}/cancel`,
        {}
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orchestratorCaseKeys.all }),
    ...mutationErrorOptions("Couldn't stop the turn"),
  });
}

/** True while a turn or a task can still change the case. */
export function isCaseActive(
  detail:
    | Pick<OrchestratorCaseSummary, "turnRunning" | "activeTaskCount">
    | undefined
): boolean {
  if (!detail) {
    return false;
  }
  return detail.turnRunning || detail.activeTaskCount > 0;
}

function casePath(caseId: string): string {
  return `/orchestrator/cases/${encodeURIComponent(caseId)}`;
}
