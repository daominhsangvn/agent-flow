import {
  decideStepReviewInputSchema,
  ReviewDecisionKind,
} from "@repo/api/src/types/project-process";
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

const ROUTE = "/workflow-runs/[runId]/review";
const BODY_MAX_BYTES = 32 * 1024;

/**
 * POST /workflow-runs/{runId}/review
 * Decides the step under review the run waits on (`{ decision, comment }`):
 * `approve` goes on (approves a plan, completes any other review),
 * `feedback` runs the step again with the comment, `reject` fails the run.
 * Feedback is open to every member; approve and reject to org admins.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/review"
>(async (auth, request, params) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      decideStepReviewInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }
    if (body.decision !== ReviewDecisionKind.Feedback) {
      const denied = await denyUnlessOrgAdmin(auth, {
        method: request.method,
        route: ROUTE,
      });
      if (denied) {
        return denied;
      }
    }
    const { runId } = await params;
    const result = await workflowRunStepInputService.decideReview(
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
    return errorResponse("Failed to record the review decision", error);
  }
});
