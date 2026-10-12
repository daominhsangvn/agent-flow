import type { ApiResult } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import type { NextResponse } from "next/server";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import type { AuthContext } from "@/lib/auth/with-auth";
import { forbiddenResponse, scheduleLogFlush } from "@/lib/route-utils";

/**
 * Returns a 403 response for non-admins, or null when the caller is an org
 * admin/owner. `subject` names the request kind in the denial log, e.g.
 * "workflow" or "project repository".
 */
export async function denyUnlessOrgAdmin(
  auth: Pick<AuthContext, "clerkOrgId" | "clerkUserId">,
  request: { method: string; route: string },
  subject: string
): Promise<NextResponse<ApiResult<never>> | null> {
  const adminStatus = await getOrgAdminStatus(
    auth.clerkOrgId,
    auth.clerkUserId
  );
  if (adminStatus.isAdmin) {
    return null;
  }
  log.warn(`Denied ${subject} request for non-admin user`, {
    clerkOrgId: auth.clerkOrgId,
    clerkUserId: auth.clerkUserId,
    reason: adminStatus.reason,
    method: request.method,
    route: request.route,
  });
  scheduleLogFlush();
  return forbiddenResponse();
}
