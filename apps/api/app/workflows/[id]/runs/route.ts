import {
  startWorkflowRunInputSchema,
  type WorkflowRunSummary,
  type WorkflowRunsResponse,
} from "@repo/api/src/types/workflow";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { workflowRunService } from "@/lib/workflows/run-service";
import {
  denyUnlessOrgAdmin,
  MANUAL_RUN_BODY_MAX_BYTES,
  runListQuerySchema,
  serviceErrorResponse,
} from "../../route-helpers";

const ROUTE = "/workflows/[id]/runs";

/**
 * GET /workflows/{id}/runs?cursor=&limit=&status=
 * Run history of one workflow, newest first. Any org member.
 */
export const GET = withAnyAuth<WorkflowRunsResponse, "/workflows/[id]/runs">(
  async ({ user }, request, params) => {
    try {
      const { params: query, errorResponse: queryError } = parseQueryParams(
        request,
        runListQuerySchema
      );
      if (queryError) {
        return queryError;
      }
      const { id } = await params;
      const result = await workflowRunService.list(user.organizationId, {
        ...query,
        workflowId: id,
      });
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to list workflow runs", error);
    }
  }
);

/**
 * POST /workflows/{id}/runs
 * Starts a run by hand for one of the workflow's triggers (e.g. with a Jira
 * issue key). Trigger filters are not applied. Org admins only.
 */
export const POST = withAnyAuth<WorkflowRunSummary, "/workflows/[id]/runs">(
  async (auth, request, params) => {
    try {
      const denied = await denyUnlessOrgAdmin(auth, {
        method: request.method,
        route: ROUTE,
      });
      if (denied) {
        return denied;
      }
      const { body, errorResponse: parseError } = await parseBody(
        request,
        startWorkflowRunInputSchema,
        { maxBytes: MANUAL_RUN_BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const { id } = await params;
      const result = await workflowRunService.startManualRun(
        auth.user.organizationId,
        id,
        body
      );
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to start workflow run", error);
    }
  }
);
