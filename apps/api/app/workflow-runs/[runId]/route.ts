import type { WorkflowRunDetail } from "@repo/api/src/types/workflow";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

/**
 * GET /workflow-runs/{runId}
 * One run with its documents, loops and post-action runs. Any org member.
 */
export const GET = withAnyAuth<WorkflowRunDetail, "/workflow-runs/[runId]">(
  async ({ user }, _request, params) => {
    try {
      const { runId } = await params;
      const run = await workflowRunService.get(user.organizationId, runId);
      if (!run) {
        return notFoundResponse("Workflow run");
      }
      return successResponse(run);
    } catch (error) {
      return errorResponse("Failed to load workflow run", error);
    }
  }
);
