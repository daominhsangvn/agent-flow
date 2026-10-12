"use client";

import type {
  CreateIntegrationRepositoryInput,
  IntegrationRepositoriesResponse,
  IntegrationRepository,
} from "@repo/api/src/types/integration";
import type {
  AddProjectRepositoryInput,
  ProjectRepositoriesResponse,
  ProjectRepository,
} from "@repo/api/src/types/project-repository";
// Cross-slice: repositories come from integration connections; their query
// keys nest under the connection so a connection change refreshes them.
import { integrationKeys } from "@repo/app/integrations/hooks/integration-keys";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * Repositories of a project (Project → Repositories), each taken from an
 * integration connection with the repositories capability. Adding and
 * removing repositories are org-admin operations; the server answers 403 to
 * anyone else.
 */

export const ProjectRepositoryMutationErrorTitle = {
  Add: "Couldn't add the repository",
  Remove: "Couldn't remove the repository",
  Create: "Couldn't create the repository",
} as const;

export const projectRepositoryKeys = {
  list: (projectId: string) =>
    [...projectKeys.detail(projectId), "repositories"] as const,
  available: (connectionId: string, query: string) =>
    [
      ...integrationKeys.connectionDetail(connectionId),
      "repositories",
      query,
    ] as const,
};

export function useProjectRepositories(
  projectId: string,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRepositoryKeys.list(projectId),
    queryFn: async (): Promise<ProjectRepository[]> => {
      const response = await apiClient.get<ProjectRepositoriesResponse>(
        repositoriesPath(projectId)
      );
      return response.repositories;
    },
    enabled: enabled && !!projectId,
  });
}

/**
 * Repositories a connection can access, for the "add repository" picker.
 * Fetched only while the picker is open with a connection chosen.
 */
export function useConnectionRepositories(
  connectionId: string,
  query: string,
  { enabled }: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRepositoryKeys.available(connectionId, query),
    queryFn: async (): Promise<IntegrationRepository[]> => {
      const search = query ? `?query=${encodeURIComponent(query)}` : "";
      const response = await apiClient.get<IntegrationRepositoriesResponse>(
        `/integrations/connections/${encodeURIComponent(connectionId)}/repositories${search}`
      );
      return response.repositories;
    },
    enabled: enabled && !!connectionId,
    retry: false,
  });
}

export function useAddProjectRepository(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: AddProjectRepositoryInput) =>
      apiClient.post<ProjectRepository>(repositoriesPath(projectId), input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: projectRepositoryKeys.list(projectId),
      });
    },
    ...mutationErrorOptions(ProjectRepositoryMutationErrorTitle.Add),
  });
}

export function useRemoveProjectRepository(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (repositoryId: string) =>
      apiClient.delete<{ deleted: true }>(
        repositoryPath(projectId, repositoryId)
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: projectRepositoryKeys.list(projectId),
      });
    },
    ...mutationErrorOptions(ProjectRepositoryMutationErrorTitle.Remove),
  });
}

/**
 * Creates a repository through a connection whose provider hosts repositories
 * itself (Local Git). Adding it to the project is a separate step.
 */
export function useCreateConnectionRepository(connectionId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateIntegrationRepositoryInput) =>
      apiClient.post<IntegrationRepository>(
        `/integrations/connections/${encodeURIComponent(connectionId)}/repositories`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [
          ...integrationKeys.connectionDetail(connectionId),
          "repositories",
        ],
      });
    },
    ...mutationErrorOptions(ProjectRepositoryMutationErrorTitle.Create),
  });
}

function repositoriesPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/repositories`;
}

function repositoryPath(projectId: string, repositoryId: string): string {
  return `${repositoriesPath(projectId)}/${encodeURIComponent(repositoryId)}`;
}
