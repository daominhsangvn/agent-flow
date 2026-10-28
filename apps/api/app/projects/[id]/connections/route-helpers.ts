import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import type { ProjectConnectionServiceError } from "@/app/projects/project-connection-service";

/**
 * Shared by the /projects/{id}/connections routes. Project connections decide
 * which bots work on which source items, so reading and changing them is for
 * org admins/owners only.
 */

export const PROJECT_CONNECTION_SUBJECT = "project connection";

/** Upper bound for create/update bodies. */
export const PROJECT_CONNECTION_BODY_MAX_BYTES = 64 * 1024;

/** Maps a project connection service error to its HTTP status with the service message. */
export function projectConnectionErrorResponse(
  error: ProjectConnectionServiceError
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(error.message), { status: error.status });
}
