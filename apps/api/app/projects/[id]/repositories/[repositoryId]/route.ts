import {
  type ProjectRepository,
  updateProjectRepositoryInputSchema,
} from "@repo/api/src/types/project-repository";
import { projectRepositoryService } from "@/app/projects/project-repository-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  PROJECT_REPOSITORY_BODY_MAX_BYTES,
  PROJECT_REPOSITORY_SUBJECT,
  projectRepositoryErrorResponse,
} from "../route-helpers";

const ROUTE = "/projects/[id]/repositories/[repositoryId]";

/**
 * PATCH /projects/{id}/repositories/{repositoryId}
 * `{ isPrimary: true }` makes the repository the project's primary one.
 * Org admins only.
 */
export const PATCH = withAnyAuth<
  ProjectRepository,
  "/projects/[id]/repositories/[repositoryId]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      PROJECT_REPOSITORY_SUBJECT
    );
    if (denied) {
      return denied;
    }
    const { id, repositoryId } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateProjectRepositoryInputSchema,
      { maxBytes: PROJECT_REPOSITORY_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await projectRepositoryService.setPrimary(
      auth.user.organizationId,
      projectId,
      repositoryId
    );
    if (!result.ok) {
      return projectRepositoryErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to update project repository", error);
  }
});

/**
 * DELETE /projects/{id}/repositories/{repositoryId}
 * Removes the repository from the project (nothing changes on the provider).
 * Org admins only.
 */
export const DELETE = withAnyAuth<
  { deleted: true },
  "/projects/[id]/repositories/[repositoryId]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      PROJECT_REPOSITORY_SUBJECT
    );
    if (denied) {
      return denied;
    }
    const { id, repositoryId } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const result = await projectRepositoryService.remove(
      auth.user.organizationId,
      projectId,
      repositoryId
    );
    if (!result.ok) {
      return projectRepositoryErrorResponse(result.error);
    }
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to remove project repository", error);
  }
});
