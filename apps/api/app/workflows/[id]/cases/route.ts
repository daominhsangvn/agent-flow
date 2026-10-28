import type { OrchestratorCaseSummary } from "@repo/api/src/types/orchestrator";
import { orchestratorCaseService } from "@/app/orchestrator/cases/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /workflows/{id}/cases
 * The orchestrated workflow's 100 most recently updated cases. Any org member.
 */
export const GET = withAnyAuth<
  OrchestratorCaseSummary[],
  "/workflows/[id]/cases"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const cases = await orchestratorCaseService.listForWorkflow(
      user.organizationId,
      id
    );
    if (!cases) {
      return notFoundResponse("Workflow");
    }
    return successResponse(cases);
  } catch (error) {
    return errorResponse("Failed to list the orchestrator cases", error);
  }
});
