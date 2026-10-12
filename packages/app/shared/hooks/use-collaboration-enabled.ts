"use client";

import type { CollaborationStatus } from "@repo/api/src/types/collaboration";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../api/use-api-client";

export const collaborationKeys = {
  status: ["collaboration", "status"] as const,
};

/**
 * Whether the server has real-time collaboration (Liveblocks): `null` until
 * known. Without it a document room's auth can only fail, so editors work on
 * the saved versions instead of joining one. A failed check counts as
 * configured, which is how every client behaved before the check existed.
 */
export function useCollaborationEnabled(): boolean | null {
  const apiClient = useApiClient();
  const { data, isError } = useQuery({
    queryKey: collaborationKeys.status,
    queryFn: () => apiClient.get<CollaborationStatus>("/collaboration/status"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (isError) {
    return true;
  }
  return data?.enabled ?? null;
}
