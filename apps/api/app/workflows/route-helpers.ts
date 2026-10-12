import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { StatusCode } from "@repo/api/src/types/result";
import { workflowRunStatusSchema } from "@repo/api/src/types/workflow";
import { NextResponse } from "next/server";
import { z } from "zod";
import { denyUnlessOrgAdmin as denyUnlessOrgAdminFor } from "@/lib/auth/deny-unless-org-admin";
import type { AuthContext } from "@/lib/auth/with-auth";
import { RUN_LIST_MAX_LIMIT } from "@/lib/workflows/run-service";

/**
 * Shared by the /workflows and /workflow-runs routes. Reads are open to every
 * org member; changes, manual runs, cancel and retry need an org admin/owner
 * (workflows spend desktop compute and post to external systems).
 */

/** Upper bound for workflow save bodies (instructions are ≤ 8 KB). */
export const WORKFLOW_BODY_MAX_BYTES = 256 * 1024;
/** Manual run input is ≤ 64 KiB of text. */
export const MANUAL_RUN_BODY_MAX_BYTES = 128 * 1024;

/** ?cursor=&limit=&status= of the run history endpoints. Unknown keys are rejected. */
export const runListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(RUN_LIST_MAX_LIMIT).optional(),
    status: workflowRunStatusSchema.optional(),
  })
  .strict();

/** Returns a 403 response for non-admins, or null when the caller is an org admin/owner. */
export function denyUnlessOrgAdmin(
  auth: Pick<AuthContext, "clerkOrgId" | "clerkUserId">,
  request: { method: string; route: string }
): Promise<NextResponse<ApiResult<never>> | null> {
  return denyUnlessOrgAdminFor(auth, request, "workflow");
}

/** Maps a workflow/run service error to its HTTP status with the service message. */
export function serviceErrorResponse(error: {
  status: StatusCode;
  message: string;
}): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(error.message), { status: error.status });
}
