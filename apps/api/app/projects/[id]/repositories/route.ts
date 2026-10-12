import {
  addProjectRepositoryInputSchema,
  type ProjectRepositoriesResponse,
  type ProjectRepository,
} from "@repo/api/src/types/project-repository";
import { projectRepositoryService } from "@/app/projects/project-repository-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  PROJECT_REPOSITORY_BODY_MAX_BYTES,
  PROJECT_REPOSITORY_SUBJECT,
  projectRepositoryErrorResponse,
} from "./route-helpers";

const ROUTE = "/projects/[id]/repositories";

/**
 * GET /projects/{id}/repositories
 * The project's repositories, primary first. Any org member.
 */
export const GET = withAnyAuth<
  ProjectRepositoriesResponse,
  "/projects/[id]/repositories"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const projectId = await resolveProjectId(id, user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const repositories = await projectRepositoryService.list(
      user.organizationId,
      projectId
    );
    if (!repositories) {
      return notFoundResponse("Project");
    }
    return successResponse({ repositories });
  } catch (error) {
    return errorResponse("Failed to list project repositories", error);
  }
});

/**
 * POST /projects/{id}/repositories
 * Adds a repository from an integration connection with the repositories
 * capability. Org admins only.
 */
export const POST = withAnyAuth<
  ProjectRepository,
  "/projects/[id]/repositories"
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
    const { id } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      addProjectRepositoryInputSchema,
      { maxBytes: PROJECT_REPOSITORY_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await projectRepositoryService.add(
      auth.user.organizationId,
      projectId,
      auth.user.id,
      body
    );
    if (!result.ok) {
      return projectRepositoryErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to add project repository", error);
  }
});
