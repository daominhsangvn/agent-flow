import type { ProjectProcessVersions } from "@repo/api/src/types/project-process";
import { projectProcessService } from "@/app/projects/project-process-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /projects/{id}/process/versions
 * The saved versions of the project's process, newest first (a reset to the
 * built-in flow has `definition: null`). Any org member.
 */
export const GET = withAnyAuth<
  ProjectProcessVersions,
  "/projects/[id]/process/versions"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const projectId = await resolveProjectId(id, user.organizationId);
    const found = projectId
      ? await projectProcessService.listVersions(user.organizationId, projectId)
      : null;
    return found ? successResponse(found) : notFoundResponse("Project");
  } catch (error) {
    return errorResponse(
      "Failed to read the project's process versions",
      error
    );
  }
});
