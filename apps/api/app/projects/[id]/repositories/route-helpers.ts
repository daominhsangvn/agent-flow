import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import type { ProjectRepositoryServiceError } from "@/app/projects/project-repository-service";

/**
 * Shared by the /projects/{id}/repositories routes. Reads are open to every
 * org member; adding, removing and choosing the primary repository need an
 * org admin/owner, because agents push to these repositories with the
 * integration connection's credentials.
 */

export const PROJECT_REPOSITORY_SUBJECT = "project repository";

/** Upper bound for add/update bodies (two ids and a flag). */
export const PROJECT_REPOSITORY_BODY_MAX_BYTES = 4 * 1024;

/** Maps a project repository service error to its HTTP status with the service message. */
export function projectRepositoryErrorResponse(
  error: ProjectRepositoryServiceError
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(error.message), { status: error.status });
}
