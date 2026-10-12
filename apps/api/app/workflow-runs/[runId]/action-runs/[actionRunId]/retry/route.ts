import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

const ROUTE = "/workflow-runs/[runId]/action-runs/[actionRunId]/retry";

/**
 * POST /workflow-runs/{runId}/action-runs/{actionRunId}/retry
 * Puts a failed or skipped post action back in the outbox with fresh
 * attempts. Pre action runs answer 409 (they ran as part of the run's start).
 * Org admins only.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/action-runs/[actionRunId]/retry"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { runId, actionRunId } = await params;
    const result = await workflowRunService.retryActionRun(
      auth.user.organizationId,
      runId,
      actionRunId
    );
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to retry the post action", error);
  }
});
