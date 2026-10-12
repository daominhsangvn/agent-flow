"use client";

import type {
  ProjectAgentInstructions,
  UpdateProjectAgentInstructionsInput,
} from "@repo/api/src/types/project-agent-instructions";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * Agent instructions of a project: the root `CLAUDE.md` of every agent loop
 * workspace on the project's repositories. Saving is an org-admin operation;
 * the server answers 403 to anyone else.
 */

export const SAVE_AGENT_INSTRUCTIONS_ERROR_TITLE =
  "Couldn't save the agent instructions";

export const projectAgentInstructionsKeys = {
  detail: (projectId: string) =>
    [...projectKeys.detail(projectId), "agent-instructions"] as const,
};

export function useProjectAgentInstructions(projectId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectAgentInstructionsKeys.detail(projectId),
    queryFn: async (): Promise<string> => {
      const response = await apiClient.get<ProjectAgentInstructions>(
        instructionsPath(projectId)
      );
      return response.instructions;
    },
    enabled: !!projectId,
  });
}

export function useSaveProjectAgentInstructions(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateProjectAgentInstructionsInput) =>
      apiClient.put<ProjectAgentInstructions>(
        instructionsPath(projectId),
        input
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        projectAgentInstructionsKeys.detail(projectId),
        saved.instructions
      );
    },
    ...mutationErrorOptions(SAVE_AGENT_INSTRUCTIONS_ERROR_TITLE),
  });
}

function instructionsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/agent-instructions`;
}
