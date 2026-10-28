"use client";

import {
  type RunnerCapabilitiesRefresh,
  RunnerCapabilitiesRefreshStatus,
} from "@repo/api/src/types/runner-capabilities";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { projectRunnerCapabilitiesKeys } from "./use-project-runner-capabilities";

/**
 * Asks an auto runner to read `AGENTFLOW.md` from its toolkit repository, and
 * follows the answer. Org admins only; the server answers 403 to anyone else.
 */

export const REFRESH_POLL_INTERVAL_MS = 2000;

export type RunnerCapabilitiesRefreshRef = {
  computeTargetId: string;
  refreshId: string;
};

export function useRequestRunnerCapabilitiesRefresh() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: {
      computeTargetId: string;
      project: string;
      repository?: string;
    }) =>
      apiClient.post<RunnerCapabilitiesRefresh>(
        refreshPath(input.computeTargetId),
        { project: input.project, repository: input.repository }
      ),
    ...mutationErrorOptions("Couldn't read the runner's toolkit"),
  });
}

export function useRunnerCapabilitiesRefresh(
  projectId: string,
  refresh: RunnerCapabilitiesRefreshRef | null
) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: [
      ...projectRunnerCapabilitiesKeys.list(projectId),
      "refresh",
      refresh?.refreshId ?? "",
    ],
    queryFn: () =>
      apiClient.get<RunnerCapabilitiesRefresh>(
        `${refreshPath(refresh?.computeTargetId ?? "")}/${encodeURIComponent(refresh?.refreshId ?? "")}`
      ),
    enabled: refresh !== null,
    refetchInterval: (current) =>
      pollInterval(current.state.data, current.state.status),
  });

  const status = query.data?.status;
  useEffect(() => {
    if (status === RunnerCapabilitiesRefreshStatus.Succeeded) {
      queryClient.invalidateQueries({
        queryKey: projectRunnerCapabilitiesKeys.list(projectId),
      });
    }
  }, [status, projectId, queryClient]);

  return query;
}

function refreshPath(computeTargetId: string): string {
  return `/compute-targets/${encodeURIComponent(computeTargetId)}/capabilities/refresh`;
}

function pollInterval(
  data: RunnerCapabilitiesRefresh | undefined,
  queryStatus: string
) {
  if (queryStatus === "error") {
    return false;
  }
  if (!data || data.status === RunnerCapabilitiesRefreshStatus.Pending) {
    return REFRESH_POLL_INTERVAL_MS;
  }
  return false;
}
