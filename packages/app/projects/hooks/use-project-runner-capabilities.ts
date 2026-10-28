"use client";

import type { ComputeTargetCapabilities } from "@repo/api/src/types/runner-capabilities";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useQuery } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * The runners' `AGENTFLOW.md` files for a project: what each runner declares it
 * can do, uploaded by the runners themselves. Read-only here.
 */

export const projectRunnerCapabilitiesKeys = {
  list: (projectId: string) =>
    [...projectKeys.detail(projectId), "runner-capabilities"] as const,
};

export function useProjectRunnerCapabilities(
  projectId: string,
  options: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRunnerCapabilitiesKeys.list(projectId),
    queryFn: () =>
      apiClient.get<ComputeTargetCapabilities[]>(
        `/projects/${encodeURIComponent(projectId)}/runner-capabilities`
      ),
    enabled: !!projectId && options.enabled,
  });
}
