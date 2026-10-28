"use client";

import type {
  CreateProjectConnectionsInput,
  IntegrationConnectionProjectsResponse,
  ProjectConnection,
  ProjectConnectionsResponse,
  UpdateProjectConnectionInput,
} from "@repo/api/src/types/project-connection";
// Cross-slice: the projects using a connection nest under the connection's
// query key, so a connection change refreshes them.
import { integrationKeys } from "@repo/app/integrations/hooks/integration-keys";
// Cross-slice: same server-message toasts as the integrations mutations.
import { mutationErrorOptions } from "@repo/app/integrations/lib/mutation-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectKeys } from "./project-keys";

/**
 * Project connections (Project → Integrations): the organization
 * connections a project uses, each under a key workflows and process steps
 * refer to. Org admins only; the server answers 403 to anyone else, so
 * callers pass `enabled: isAdmin`.
 */

export const ProjectConnectionMutationErrorTitle = {
  Add: "Couldn't add the connections",
  Update: "Couldn't save the connection",
  Remove: "Couldn't remove the connection",
} as const;

export const projectConnectionKeys = {
  all: () => ["project-connections"] as const,
  list: (projectId: string) =>
    [...projectKeys.detail(projectId), "connections"] as const,
  projectsOfConnection: (connectionId: string) =>
    [...integrationKeys.connectionDetail(connectionId), "projects"] as const,
};

export function useProjectConnections(
  projectId: string,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectConnectionKeys.list(projectId),
    queryFn: async (): Promise<ProjectConnection[]> => {
      const response = await apiClient.get<ProjectConnectionsResponse>(
        connectionsPath(projectId)
      );
      return response.connections;
    },
    enabled: enabled && !!projectId,
  });
}

/** Every project connection of the organization (the workflow editor's catalog). */
export function useOrgProjectConnections({ enabled }: { enabled: boolean }) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectConnectionKeys.all(),
    queryFn: async (): Promise<ProjectConnection[]> => {
      const response = await apiClient.get<ProjectConnectionsResponse>(
        "/project-connections"
      );
      return response.connections;
    },
    enabled,
  });
}

/** The projects using an organization connection, for its settings dialog. */
export function useConnectionProjects(
  connectionId: string,
  { enabled }: { enabled: boolean }
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectConnectionKeys.projectsOfConnection(connectionId),
    queryFn: async () => {
      const response =
        await apiClient.get<IntegrationConnectionProjectsResponse>(
          `/integrations/connections/${encodeURIComponent(connectionId)}/projects`
        );
      return response.projects;
    },
    enabled: enabled && !!connectionId,
  });
}

export function useAddProjectConnection(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateProjectConnectionsInput) =>
      apiClient.post<ProjectConnectionsResponse>(
        connectionsPath(projectId),
        input
      ),
    onSuccess: () => invalidate(queryClient, projectId),
    ...mutationErrorOptions(ProjectConnectionMutationErrorTitle.Add),
  });
}

export type UpdateProjectConnectionVariables = {
  id: string;
  input: UpdateProjectConnectionInput;
};

export function useUpdateProjectConnection(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, input }: UpdateProjectConnectionVariables) =>
      apiClient.patch<ProjectConnection>(connectionPath(projectId, id), input),
    onSuccess: () => invalidate(queryClient, projectId),
    ...mutationErrorOptions(ProjectConnectionMutationErrorTitle.Update),
  });
}

export function useRemoveProjectConnection(projectId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(connectionPath(projectId, id)),
    onSuccess: () => invalidate(queryClient, projectId),
    ...mutationErrorOptions(ProjectConnectionMutationErrorTitle.Remove),
  });
}

function connectionsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/connections`;
}

function connectionPath(projectId: string, id: string): string {
  return `${connectionsPath(projectId)}/${encodeURIComponent(id)}`;
}

/**
 * A project connection changes the project's list and the "used by
 * projects" of its organization connection (whose usage count changes too).
 */
function invalidate(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: projectConnectionKeys.list(projectId),
    }),
    queryClient.invalidateQueries({ queryKey: integrationKeys.connections() }),
    queryClient.invalidateQueries({ queryKey: projectConnectionKeys.all() }),
  ]).then(() => undefined);
}
