import { z } from "zod";

/**
 * Repositories a project works on, each taken from an integration connection
 * with the repositories capability (GitHub, Azure DevOps, ...). Agent loops
 * clone and push them with credentials the connection issues per loop, and
 * pull requests are opened through the same connection by workflow actions.
 *
 * Exactly one repository of a project is primary: loops run in it, and the
 * others are checked out next to it as additional repositories.
 */
export type ProjectRepository = {
  id: string;
  projectId: string;
  /**
   * Null when the connection was deleted; the repository then cannot be used
   * until it is removed and added again from another connection.
   */
  connectionId: string | null;
  connectionName: string | null;
  provider: string;
  externalId: string;
  /** `owner/repo` on GitHub, `organization/project/repo` on Azure DevOps. */
  fullName: string;
  name: string;
  defaultBranch: string | null;
  webUrl: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectRepositoriesResponse = {
  repositories: ProjectRepository[];
};

export const PROJECT_REPOSITORIES_MAX = 20;

export const addProjectRepositoryInputSchema = z.object({
  connectionId: z.string().uuid(),
  externalId: z.string().trim().min(1).max(255),
  /** The first repository of a project becomes primary regardless. */
  isPrimary: z.boolean().optional(),
});
export type AddProjectRepositoryInput = z.infer<
  typeof addProjectRepositoryInputSchema
>;

/** PATCH /projects/{id}/repositories/{repositoryId}: make it the primary repository. */
export const updateProjectRepositoryInputSchema = z.object({
  isPrimary: z.literal(true),
});
export type UpdateProjectRepositoryInput = z.infer<
  typeof updateProjectRepositoryInputSchema
>;
