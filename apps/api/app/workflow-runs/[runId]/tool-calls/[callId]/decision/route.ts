import { toolCallDecisionRequestSchema } from "@repo/api/src/types/integration-tools";
import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

const ROUTE = "/workflow-runs/[runId]/tool-calls/[callId]/decision";

/**
 * POST /workflow-runs/{runId}/tool-calls/{callId}/decision
 * Approves (carries out) or rejects an agent's integration tool call whose
 * grant requires approval. Org admins only.
 */
export const POST = withAnyAuth<
  WorkflowRunDetail,
  "/workflow-runs/[runId]/tool-calls/[callId]/decision"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const { body, errorResponse: invalid } = await parseBody(
      request,
      toolCallDecisionRequestSchema
    );
    if (invalid) {
      return invalid;
    }
    const { runId, callId } = await params;
    const result = await workflowRunService.decideToolCall({
      organizationId: auth.user.organizationId,
      runId,
      callId,
      decision: body.decision,
      userId: auth.user.id,
    });
    if (!result.ok) {
      return serviceErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to decide the tool call", error);
  }
});
