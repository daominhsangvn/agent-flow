import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

const ROUTE = "/workflow-runs/[runId]/cancel";

/**
 * Cancelling stops the run's active loops on their desktops first (each kill
 * may wait for an unreachable desktop), like POST /loops/{id}/cancel.
 */
export const maxDuration = 60;

/**
 * POST /workflow-runs/{runId}/cancel
 * Cancels the run's active loops, then the run. Org admins only.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/cancel"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { runId } = await params;
    const result = await workflowRunService.cancel(
      auth.user.organizationId,
      runId
    );
    scheduleLogFlush();
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to cancel workflow run", error);
  }
});
