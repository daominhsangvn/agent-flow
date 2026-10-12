import { decideStepApprovalInputSchema } from "@repo/api/src/types/project-process";
import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunStepInputService } from "@/lib/workflows/run-step-input-service";

const ROUTE = "/workflow-runs/[runId]/approval";
const BODY_MAX_BYTES = 32 * 1024;

/**
 * POST /workflow-runs/{runId}/approval
 * Decides the approval step the run waits on (`{ approved, comment }`):
 * approved goes on with the next step, rejected fails the run with the
 * comment. Org admins only.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/approval"
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
    const { body, errorResponse: parseError } = await parseBody(
      request,
      decideStepApprovalInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    const result = await workflowRunStepInputService.decideApproval(
      auth.user.organizationId,
      auth.user.id,
      runId,
      body
    );
    scheduleLogFlush();
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to record the approval", error);
  }
});
