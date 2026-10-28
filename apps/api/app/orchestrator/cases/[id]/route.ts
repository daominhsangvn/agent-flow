import {
  type OrchestratorCaseDetail,
  type UpdateOrchestratorCaseInput,
  updateOrchestratorCaseInputSchema,
} from "@repo/api/src/types/orchestrator";
import { orchestratorCaseService } from "@/app/orchestrator/cases/service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const ROUTE = "/orchestrator/cases/[id]";
const BODY_MAX_BYTES = 4096;

/**
 * GET /orchestrator/cases/{id}
 * A case with its conversations, turns, tasks, waits and decisions. Any org
 * member.
 */
export const GET = withAnyAuth<
  OrchestratorCaseDetail,
  "/orchestrator/cases/[id]"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const found = await orchestratorCaseService.get(user.organizationId, id);
    return found ? successResponse(found) : notFoundResponse("Case");
  } catch (error) {
    return errorResponse("Failed to read the orchestrator case", error);
  }
});

/**
 * PATCH /orchestrator/cases/{id}
 * Closes or reopens a case (`{ status }`). Org admins only.
 */
export const PATCH = withAnyAuth<
  { status: UpdateOrchestratorCaseInput["status"] },
  "/orchestrator/cases/[id]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      "orchestrator cases"
    );
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const { body, errorResponse: invalid } = await parseBody(
      request,
      updateOrchestratorCaseInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (invalid || !body) {
      return invalid;
    }
    const result = await orchestratorCaseService.setStatus(
      auth.user.organizationId,
      id,
      body
    );
    if (result.ok) {
      return successResponse(result.value);
    }
    return notFoundResponse("Case");
  } catch (error) {
    return errorResponse("Failed to update the orchestrator case", error);
  }
});
