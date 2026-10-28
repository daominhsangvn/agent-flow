import {
  type ProjectConnection,
  updateProjectConnectionInputSchema,
} from "@repo/api/src/types/project-connection";
import { projectConnectionService } from "@/app/projects/project-connection-service";
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
  PROJECT_CONNECTION_BODY_MAX_BYTES,
  PROJECT_CONNECTION_SUBJECT,
  projectConnectionErrorResponse,
} from "../route-helpers";

const ROUTE = "/projects/[id]/connections/[projectConnectionId]";

/**
 * PATCH /projects/{id}/connections/{projectConnectionId}
 * Changes the name or the settings. The connection and the key never change.
 * Org admins only.
 */
export const PATCH = withAnyAuth<
  ProjectConnection,
  "/projects/[id]/connections/[projectConnectionId]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      PROJECT_CONNECTION_SUBJECT
    );
    if (denied) {
      return denied;
    }
    const { id, projectConnectionId } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateProjectConnectionInputSchema,
      { maxBytes: PROJECT_CONNECTION_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await projectConnectionService.update(
      auth.user.organizationId,
      projectId,
      projectConnectionId,
      body
    );
    if (!result.ok) {
      return projectConnectionErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to update project connection", error);
  }
});

/**
 * DELETE /projects/{id}/connections/{projectConnectionId}
 * Removes the connection from the project (the organization connection
 * stays). Org admins only.
 */
export const DELETE = withAnyAuth<
  { deleted: true },
  "/projects/[id]/connections/[projectConnectionId]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      PROJECT_CONNECTION_SUBJECT
    );
    if (denied) {
      return denied;
    }
    const { id, projectConnectionId } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const result = await projectConnectionService.remove(
      auth.user.organizationId,
      projectId,
      projectConnectionId
    );
    if (!result.ok) {
      return projectConnectionErrorResponse(result.error);
    }
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to remove project connection", error);
  }
});
