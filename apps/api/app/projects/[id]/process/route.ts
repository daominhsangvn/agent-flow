import { failure } from "@repo/api/src/types/common";
import {
  type ProjectProcessState,
  updateProjectProcessInputSchema,
} from "@repo/api/src/types/project-process";
import { NextResponse } from "next/server";
import { computeTargetCapabilitiesRefreshService } from "@/app/compute-targets/capabilities-refresh-service";
import { projectProcessService } from "@/app/projects/project-process-service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const ROUTE = "/projects/[id]/process";
const BODY_MAX_BYTES = 256 * 1024;

/**
 * GET /projects/{id}/process
 * The project's current process (`current: null`: the built-in AgentFlow
 * flow of each workflow's agent settings). Any org member.
 */
export const GET = withAnyAuth<ProjectProcessState, "/projects/[id]/process">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const projectId = await resolveProjectId(id, user.organizationId);
      const found = projectId
        ? await projectProcessService.get(user.organizationId, projectId)
        : null;
      return found ? successResponse(found) : notFoundResponse("Project");
    } catch (error) {
      return errorResponse("Failed to read the project's process", error);
    }
  }
);

/**
 * PUT /projects/{id}/process
 * Saves a new version of the project's process (`{ process }`, null to go
 * back to the built-in flow). Runs already started keep their snapshot. Org
 * admins only.
 */
export const PUT = withAnyAuth<ProjectProcessState, "/projects/[id]/process">(
  async (auth, request, params) => {
    try {
      const denied = await denyUnlessOrgAdmin(
        auth,
        { method: request.method, route: ROUTE },
        "the project process"
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
        updateProjectProcessInputSchema,
        { maxBytes: BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const before = await projectProcessService.findCurrent(
        auth.user.organizationId,
        projectId
      );
      const result = await projectProcessService.save(
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
      computeTargetCapabilitiesRefreshService.refreshAfterProcessSave(
        auth.user.organizationId,
        projectId,
        before,
        result.value
      );
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to save the project's process", error);
    }
  }
);
