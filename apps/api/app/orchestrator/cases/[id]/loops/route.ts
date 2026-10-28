import type { OrchestratorCaseLoops } from "@repo/api/src/types/orchestrator";
import { orchestratorCaseService } from "@/app/orchestrator/cases/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /orchestrator/cases/{id}/loops
 * The loops, sessions and pull requests of a case's tasks. Any org member.
 */
export const GET = withAnyAuth<
  OrchestratorCaseLoops,
  "/orchestrator/cases/[id]/loops"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const found = await orchestratorCaseService.getLoops(
      user.organizationId,
      id
    );
    return found ? successResponse(found) : notFoundResponse("Case");
  } catch (error) {
    return errorResponse("Failed to read the case's loops", error);
  }
});
