import {
  saveWorkflowInputSchema,
  type Workflow,
  type WorkflowsResponse,
} from "@repo/api/src/types/workflow";
import { resolveConfigViewer } from "@/app/integrations/connections/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { workflowService } from "@/lib/workflows/workflow-service";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
  WORKFLOW_BODY_MAX_BYTES,
} from "./route-helpers";

const ROUTE = "/workflows";

/**
 * GET /workflows
 * Every workflow of the organization with run counts. Any org member;
 * members who are not org admins see url-kind trigger and action config
 * fields (e.g. webhook target URLs) as their origin only.
 */
export const GET = withAnyAuth<WorkflowsResponse, "/workflows">(
  async (auth) => {
    try {
      const workflows = await workflowService.list(
        auth.user.organizationId,
        await resolveConfigViewer(auth)
      );
      return successResponse({ workflows });
    } catch (error) {
      return errorResponse("Failed to list workflows", error);
    }
  }
);

/**
 * POST /workflows
 * Creates a workflow after validating its triggers and actions against the
 * provider registry. Org admins only.
 */
export const POST = withAnyAuth<Workflow, "/workflows">(
  async (auth, request) => {
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
        saveWorkflowInputSchema,
        { maxBytes: WORKFLOW_BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const result = await workflowService.create(
        auth.user.organizationId,
        auth.user.id,
        body
      );
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to create workflow", error);
    }
  }
);
