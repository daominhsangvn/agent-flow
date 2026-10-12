import {
  saveWorkflowInputSchema,
  setWorkflowEnabledInputSchema,
  type Workflow,
} from "@repo/api/src/types/workflow";
import { resolveConfigViewer } from "@/app/integrations/connections/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { workflowService } from "@/lib/workflows/workflow-service";
import {
  denyUnlessOrgAdmin,
  serviceErrorResponse,
  WORKFLOW_BODY_MAX_BYTES,
} from "../route-helpers";

const ROUTE = "/workflows/[id]";

/**
 * GET /workflows/{id}
 * One workflow with its triggers, actions and run counts. Any org member;
 * members who are not org admins see url-kind trigger and action config
 * fields as their origin only.
 */
export const GET = withAnyAuth<Workflow, "/workflows/[id]">(
  async (auth, _request, params) => {
    try {
      const { id } = await params;
      const workflow = await workflowService.get(
        auth.user.organizationId,
        id,
        await resolveConfigViewer(auth)
      );
      if (!workflow) {
        return notFoundResponse("Workflow");
      }
      return successResponse(workflow);
    } catch (error) {
      return errorResponse("Failed to load workflow", error);
    }
  }
);

/**
 * PUT /workflows/{id}
 * Replaces the workflow, including its triggers and actions (ids sent back
 * are kept). Org admins only.
 */
export const PUT = withAnyAuth<Workflow, "/workflows/[id]">(
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
        saveWorkflowInputSchema,
        { maxBytes: WORKFLOW_BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const { id } = await params;
      const result = await workflowService.update(
        auth.user.organizationId,
        id,
        auth.user.id,
        body
      );
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to update workflow", error);
    }
  }
);

/**
 * PATCH /workflows/{id}
 * Turns the workflow on or off without re-sending it. Off always succeeds;
 * on re-validates the stored workflow as the caller (400 with the reason).
 * Org admins only.
 */
export const PATCH = withAnyAuth<Workflow, "/workflows/[id]">(
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
        setWorkflowEnabledInputSchema,
        { maxBytes: WORKFLOW_BODY_MAX_BYTES }
      );
      if (parseError || !body) {
        return parseError;
      }
      const { id } = await params;
      const result = await workflowService.setEnabled(
        auth.user.organizationId,
        id,
        auth.user.id,
        body
      );
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to update workflow", error);
    }
  }
);

/**
 * DELETE /workflows/{id}
 * Deletes the workflow and its run history. Org admins only.
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/workflows/[id]">(
  async (auth, request, params) => {
    try {
      const denied = await denyUnlessOrgAdmin(auth, {
        method: request.method,
        route: ROUTE,
      });
      if (denied) {
        return denied;
      }
      const { id } = await params;
      const result = await workflowService.remove(auth.user.organizationId, id);
      if (!result.ok) {
        return serviceErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to delete workflow", error);
    }
  },
  { requiredScopes: ["delete"] }
);
