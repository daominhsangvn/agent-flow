import type { RunnerCapabilitiesRefresh } from "@repo/api/src/types/runner-capabilities";
import { computeTargetCapabilitiesRefreshService } from "@/app/compute-targets/capabilities-refresh-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /compute-targets/:id/capabilities/refresh/:refreshId
 * How a capabilities refresh went. Any org member.
 */
export const GET = withAnyAuth<
  RunnerCapabilitiesRefresh,
  "/compute-targets/[id]/capabilities/refresh/[refreshId]"
>(async ({ user }, _request, params) => {
  try {
    const { id, refreshId } = await params;
    const refresh = await computeTargetCapabilitiesRefreshService.status(
      user.organizationId,
      id,
      refreshId
    );
    if (!refresh) {
      return notFoundResponse("Capabilities refresh");
    }
    return successResponse(refresh);
  } catch (error) {
    return errorResponse("Failed to read the capabilities refresh", error);
  }
});
