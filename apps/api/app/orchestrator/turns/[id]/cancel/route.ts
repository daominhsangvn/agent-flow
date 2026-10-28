import { failure } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { orchestratorCaseService } from "@/app/orchestrator/cases/service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";

const ROUTE = "/orchestrator/turns/[id]/cancel";

const MESSAGES: Record<number, string> = {
  [Status.NotFound]: "No running turn has that id",
  [Status.BadRequest]: "The turn has no runner",
  [Status.BadGateway]: "The runner could not be reached",
  [Status.Forbidden]: "Forbidden",
};

/**
 * POST /orchestrator/turns/{id}/cancel
 * Stops a running orchestrator turn. Org admins only.
 */
export const POST = withAnyAuth<
  { turnId: string },
  "/orchestrator/turns/[id]/cancel"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      "orchestrator turns"
    );
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const result = await orchestratorCaseService.cancelTurn(
      auth.user.organizationId,
      auth.user.id,
      id
    );
    if (result.ok) {
      return successResponse(result.value);
    }
    return NextResponse.json(failure(MESSAGES[result.error] ?? "Failed"), {
      status: result.error,
    });
  } catch (error) {
    return errorResponse("Failed to stop the turn", error);
  }
});
