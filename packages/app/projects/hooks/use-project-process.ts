"use client";

import type {
  ProjectProcessState,
  ProjectProcessVersions,
  UpdateProjectProcessInput,
} from "@repo/api/src/types/project-process";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * The process of a project: the steps its workflow runs follow between pre
 * and post actions. Saving is an org-admin operation (the server answers 403
 * to anyone else); every save is a new version.
 */

export const SAVE_PROJECT_PROCESS_ERROR_TITLE =
  "Couldn't save the project's process";

export const projectProcessKeys = {
  detail: (projectId: string) =>
    [...projectKeys.detail(projectId), "process"] as const,
  versions: (projectId: string) =>
    [...projectKeys.detail(projectId), "process", "versions"] as const,
};

export function useProjectProcess(projectId: string | null | undefined) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectProcessKeys.detail(projectId ?? ""),
    queryFn: () =>
      apiClient.get<ProjectProcessState>(processPath(projectId ?? "")),
    enabled: !!projectId,
  });
}

/** Loaded only while the history is open. */
export function useProjectProcessVersions(projectId: string, enabled: boolean) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectProcessKeys.versions(projectId),
    queryFn: () =>
      apiClient.get<ProjectProcessVersions>(
        `${processPath(projectId)}/versions`
      ),
    enabled: enabled && !!projectId,
  });
}

export function useSaveProjectProcess(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateProjectProcessInput) =>
      apiClient.put<ProjectProcessState>(processPath(projectId), input),
    onSuccess: async (saved) => {
      queryClient.setQueryData(projectProcessKeys.detail(projectId), saved);
      await queryClient.invalidateQueries({
        queryKey: projectProcessKeys.versions(projectId),
      });
    },
    ...mutationErrorOptions(SAVE_PROJECT_PROCESS_ERROR_TITLE),
  });
}

function processPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/process`;
}
