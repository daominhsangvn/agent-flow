import type { WorkflowRunsResponse } from "@repo/api/src/types/workflow";
import {
  runListQuerySchema,
  serviceErrorResponse,
} from "@/app/workflows/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";

/**
 * GET /workflow-runs?cursor=&limit=&status=
 * Runs of every workflow of the organization, newest first. Any org member.
 */
export const GET = withAnyAuth<WorkflowRunsResponse, "/workflow-runs">(
  async ({ user }, request) => {
    try {
      const { params: query, errorResponse: queryError } = parseQueryParams(
        request,
        runListQuerySchema
      );
      if (queryError) {
        return queryError;
      }
      const result = await workflowRunService.list(user.organizationId, query);
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to list workflow runs", error);
    }
  }
);
