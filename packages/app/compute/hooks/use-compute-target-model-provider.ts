"use client";

import type {
  ComputeTargetModelProvider,
  UpdateComputeTargetModelProviderInput,
} from "@repo/api/src/types/compute-target-model-provider";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Model provider of one computer (which endpoint Claude Code uses for loops
 * there). Read only while its dialog is open; owner-only on the server.
 */

export const computeTargetModelProviderKeys = {
  detail: (computeTargetId: string) =>
    ["compute-targets", computeTargetId, "model-provider"] as const,
};

export function useComputeTargetModelProvider(
  computeTargetId: string,
  { enabled }: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computeTargetModelProviderKeys.detail(computeTargetId),
    queryFn: () =>
      apiClient.get<ComputeTargetModelProvider>(path(computeTargetId)),
    enabled: enabled && !!computeTargetId,
  });
}

export function useUpdateComputeTargetModelProvider(computeTargetId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateComputeTargetModelProviderInput) =>
      apiClient.put<ComputeTargetModelProvider>(path(computeTargetId), input),
    onSuccess: (provider) => {
      queryClient.setQueryData(
        computeTargetModelProviderKeys.detail(computeTargetId),
        provider
      );
    },
    ...mutationErrorOptions("Couldn't save the model provider"),
  });
}

function path(computeTargetId: string): string {
  return `/compute-targets/${encodeURIComponent(computeTargetId)}/model-provider`;
}
