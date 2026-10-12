import { failure } from "@repo/api/src/types/common";
import {
  type ProjectRunners,
  updateProjectRunnersInputSchema,
} from "@repo/api/src/types/project-runners";
import { NextResponse } from "next/server";
import { projectRunnersService } from "@/app/projects/project-runners-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const ROUTE = "/projects/[id]/runners";
const BODY_MAX_BYTES = 4 * 1024;

/**
 * GET /projects/{id}/runners
 * The computers the project's agent loops run on, with their status, load
 * and reported tools. Any org member.
 */
export const GET = withAnyAuth<ProjectRunners, "/projects/[id]/runners">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const projectId = await resolveProjectId(id, user.organizationId);
      const found = projectId
        ? await projectRunnersService.get(user.organizationId, projectId)
        : null;
      return found ? successResponse(found) : notFoundResponse("Project");
    } catch (error) {
      return errorResponse("Failed to read the project's runners", error);
    }
  }
);

/**
 * PUT /projects/{id}/runners
 * Replaces the project's runners (`{ runnerIds }`, empty for none). Org admins
 * only, like the project's repositories.
 */
export const PUT = withAnyAuth<ProjectRunners, "/projects/[id]/runners">(
  async (auth, request, params) => {
    try {
      const denied = await denyUnlessOrgAdmin(
        auth,
        { method: request.method, route: ROUTE },
        "project runners"
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
        updateProjectRunnersInputSchema,
        { maxBytes: BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const result = await projectRunnersService.update(
        auth.user.organizationId,
        auth.user.id,
        projectId,
        body
      );
      if (!result.ok) {
        return NextResponse.json(failure(result.error.message), {
          status: result.error.status,
        });
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to save the project's runners", error);
    }
  }
);
