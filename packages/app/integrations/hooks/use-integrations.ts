"use client";

import type {
  CreateIntegrationConnectionInput,
  IntegrationConnection,
  IntegrationConnectionsResponse,
  IntegrationConnectionTestResult,
  IntegrationDeliveriesResponse,
  IntegrationDelivery,
  IntegrationInboundDetails,
  IntegrationProviderSummary,
  IntegrationProvidersResponse,
  UpdateIntegrationConnectionInput,
} from "@repo/api/src/types/integration";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  IntegrationMutationErrorTitle,
  mutationErrorOptions,
} from "../lib/mutation-error";
import { integrationKeys } from "./integration-keys";

type QueryOptions<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

/**
 * The provider catalog is code-defined on the server (the provider registry),
 * so it only changes with a deploy. Cache it for a long time instead of
 * refetching it on every editor and settings mount.
 */
const PROVIDER_CATALOG_STALE_TIME_MS = 30 * 60 * 1000;

const CONNECTIONS_PATH = "/integrations/connections";

// Queries

/** The provider catalog (connection fields, triggers, actions) the UI renders from. */
export function useIntegrationProviders(
  options?: QueryOptions<IntegrationProviderSummary[]>
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: integrationKeys.providers(),
    queryFn: async () => {
      const response = await apiClient.get<IntegrationProvidersResponse>(
        "/integrations/providers"
      );
      return response.providers;
    },
    staleTime: PROVIDER_CATALOG_STALE_TIME_MS,
    ...options,
  });
}

export function useIntegrationConnections(
  options?: QueryOptions<IntegrationConnection[]>
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: integrationKeys.connectionList(),
    queryFn: async () => {
      const response =
        await apiClient.get<IntegrationConnectionsResponse>(CONNECTIONS_PATH);
      return response.connections;
    },
    ...options,
  });
}

export function useIntegrationConnection(
  id: string,
  options?: QueryOptions<IntegrationConnection>
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: integrationKeys.connectionDetail(id),
    queryFn: () => apiClient.get<IntegrationConnection>(connectionPath(id)),
    enabled: !!id,
    ...options,
  });
}

/**
 * Admin-only inbound endpoint details, including the shared secret. Fetched
 * only while the admin has the inbound setup panel open (`enabled`), never on
 * mount, so the secret is not pulled into every Settings visit.
 */
export function useIntegrationInbound(
  id: string,
  { enabled }: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: integrationKeys.inbound(id),
    queryFn: () =>
      apiClient.get<IntegrationInboundDetails>(`${connectionPath(id)}/inbound`),
    enabled: enabled && !!id,
  });
}

/** The latest inbound deliveries of a connection, fetched while the panel is open. */
export function useIntegrationDeliveries(
  id: string,
  { enabled }: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: integrationKeys.deliveries(id),
    queryFn: async (): Promise<IntegrationDelivery[]> => {
      const response = await apiClient.get<IntegrationDeliveriesResponse>(
        `${connectionPath(id)}/deliveries`
      );
      return response.deliveries;
    },
    enabled: enabled && !!id,
  });
}

// Mutations
//
// Every mutation below toasts the server's message on failure (see
// `mutationErrorOptions`); the dialogs also show it inline.

export function useCreateIntegrationConnection() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateIntegrationConnectionInput) =>
      apiClient.post<IntegrationConnection>(CONNECTIONS_PATH, input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connections(),
      });
    },
    ...mutationErrorOptions(IntegrationMutationErrorTitle.CreateConnection),
  });
}

export type UpdateIntegrationConnectionVariables = {
  id: string;
  input: UpdateIntegrationConnectionInput;
};

export function useUpdateIntegrationConnection() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, input }: UpdateIntegrationConnectionVariables) =>
      apiClient.patch<IntegrationConnection>(connectionPath(id), input),
    onSuccess: () => {
      // The inbound URL and the delivery settings can change with an update,
      // so refresh the list, the detail and everything nested under it.
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connections(),
      });
    },
    ...mutationErrorOptions(IntegrationMutationErrorTitle.UpdateConnection),
  });
}

export function useDeleteIntegrationConnection() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(connectionPath(id)),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({
        queryKey: integrationKeys.connectionDetail(id),
      });
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connectionList(),
      });
    },
    ...mutationErrorOptions(IntegrationMutationErrorTitle.DeleteConnection),
  });
}

/**
 * Re-validates the stored credentials with the provider. The test updates the
 * connection's status, account and `lastValidatedAt`, so the cached
 * connections are refreshed afterwards.
 */
export function useTestIntegrationConnection() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<IntegrationConnectionTestResult>(
        `${connectionPath(id)}/test`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connections(),
      });
    },
    ...mutationErrorOptions(IntegrationMutationErrorTitle.TestConnection),
  });
}

/** Issues a new inbound key and secret; the old URL and secret stop working. */
export function useRotateIntegrationInbound() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<IntegrationInboundDetails>(
        `${connectionPath(id)}/inbound/rotate`,
        {}
      ),
    onSuccess: (details, id) => {
      queryClient.setQueryData(integrationKeys.inbound(id), details);
      // The connection's public inbound URL changed with the key.
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connectionList(),
      });
      queryClient.invalidateQueries({
        queryKey: integrationKeys.connectionDetail(id),
        exact: true,
      });
    },
    ...mutationErrorOptions(IntegrationMutationErrorTitle.RotateInbound),
  });
}

function connectionPath(id: string): string {
  return `${CONNECTIONS_PATH}/${encodeURIComponent(id)}`;
}
