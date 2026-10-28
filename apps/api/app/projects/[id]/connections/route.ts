import {
  createProjectConnectionsInputSchema,
  type ProjectConnectionsResponse,
} from "@repo/api/src/types/project-connection";
import { projectConnectionService } from "@/app/projects/project-connection-service";
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
  PROJECT_CONNECTION_BODY_MAX_BYTES,
  PROJECT_CONNECTION_SUBJECT,
  projectConnectionErrorResponse,
} from "./route-helpers";

const ROUTE = "/projects/[id]/connections";

/**
 * GET /projects/{id}/connections
 * The project's connections (key, connection, settings). Org admins only.
 */
export const GET = withAnyAuth<
  ProjectConnectionsResponse,
  "/projects/[id]/connections"
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
    const { id } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const connections = await projectConnectionService.list(
      auth.user.organizationId,
      projectId
    );
    if (!connections) {
      return notFoundResponse("Project");
    }
    return successResponse({ connections });
  } catch (error) {
    return errorResponse("Failed to list project connections", error);
  }
});

/**
 * POST /projects/{id}/connections
 * Adds one or more connections of one integration (one bot each) to the
 * project, each under its own key, with the same project settings; all or
 * none. 409 when a key, a connection or a source item is already taken.
 * Org admins only.
 */
export const POST = withAnyAuth<
  ProjectConnectionsResponse,
  "/projects/[id]/connections"
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
    const { id } = await params;
    const projectId = await resolveProjectId(id, auth.user.organizationId);
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createProjectConnectionsInputSchema,
      { maxBytes: PROJECT_CONNECTION_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await projectConnectionService.add(
      auth.user.organizationId,
      projectId,
      auth.user.id,
      body
    );
    if (!result.ok) {
      return projectConnectionErrorResponse(result.error);
    }
    return successResponse({ connections: result.value });
  } catch (error) {
    return errorResponse("Failed to add project connections", error);
  }
});
