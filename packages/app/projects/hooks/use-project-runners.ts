"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import type {
  ProjectRunner,
  ProjectRunners,
  UpdateProjectRunnersInput,
} from "@repo/api/src/types/project-runners";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * Runners of a project: the computers its agent loops run on. Changing them
 * is an org-admin operation; the server answers 403 to anyone else.
 */

export const SAVE_PROJECT_RUNNERS_ERROR_TITLE =
  "Couldn't save the project's runners";

export const projectRunnersKeys = {
  detail: (projectId: string) =>
    [...projectKeys.detail(projectId), "runners"] as const,
  computers: ["compute-targets", "available-for-project-runners"] as const,
};

export function useProjectRunners(projectId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRunnersKeys.detail(projectId),
    queryFn: async (): Promise<ProjectRunner[]> => {
      const response = await apiClient.get<ProjectRunners>(
        runnersPath(projectId)
      );
      return response.runners;
    },
    enabled: !!projectId,
  });
}

export function useSaveProjectRunners(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateProjectRunnersInput) =>
      apiClient.put<ProjectRunners>(runnersPath(projectId), input),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        projectRunnersKeys.detail(projectId),
        saved.runners
      );
    },
    ...mutationErrorOptions(SAVE_PROJECT_RUNNERS_ERROR_TITLE),
  });
}

/** Computers the user can assign (their own and the shared ones), when `enabled`. */
export function useAssignableComputers(enabled: boolean) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRunnersKeys.computers,
    queryFn: () => apiClient.get<ComputeTarget[]>("/compute-targets"),
    enabled,
  });
}

function runnersPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/runners`;
}
