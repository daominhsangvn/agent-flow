import type { IntegrationConnectionProjectsResponse } from "@repo/api/src/types/project-connection";
import { projectConnectionService } from "@/app/projects/project-connection-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { denyUnlessOrgAdmin } from "../../route-helpers";

const ROUTE = "/integrations/connections/[id]/projects";

/**
 * GET /integrations/connections/{id}/projects
 * The projects that use the connection, with their keys. Org admins only.
 */
export const GET = withAnyAuth<
  IntegrationConnectionProjectsResponse,
  "/integrations/connections/[id]/projects"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const projects = await projectConnectionService.listForConnection(
      auth.user.organizationId,
      id
    );
    if (!projects) {
      return notFoundResponse("Integration connection");
    }
    return successResponse({ projects });
  } catch (error) {
    return errorResponse("Failed to list the connection's projects", error);
  }
});
