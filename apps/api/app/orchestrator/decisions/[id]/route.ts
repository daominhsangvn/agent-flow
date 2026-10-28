import { failure } from "@repo/api/src/types/common";
import { decideOrchestratorDecisionInputSchema } from "@repo/api/src/types/orchestrator";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { orchestratorDecisionService } from "@/app/orchestrator/decisions/service";
import { denyUnlessOrgAdmin } from "@/lib/auth/deny-unless-org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

const ROUTE = "/orchestrator/decisions/[id]";
const BODY_MAX_BYTES = 16 * 1024;

/**
 * POST /orchestrator/decisions/{id}
 * An org admin approves or rejects what a project orchestrator asked
 * (`{ approved, comment }`); the conversation that asked moves at once.
 */
export const POST = withAnyAuth<
  { conversationId: string },
  "/orchestrator/decisions/[id]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(
      auth,
      { method: request.method, route: ROUTE },
      "orchestrator decisions"
    );
    if (denied) {
      return denied;
    }
    const { id } = await params;
    const { body, errorResponse: invalid } = await parseBody(
      request,
      decideOrchestratorDecisionInputSchema,
      { maxBytes: BODY_MAX_BYTES }
    );
    if (invalid || !body) {
      return invalid;
    }
    const result = await orchestratorDecisionService.decideByButton(
      auth.user.organizationId,
      auth.user.id,
      id,
      body
    );
    if (result.ok) {
      return successResponse(result.value);
    }
    return NextResponse.json(
      failure(
        result.error === Status.NotFound
          ? "No pending decision has that id"
          : "Forbidden"
      ),
      { status: result.error }
    );
  } catch (error) {
    return errorResponse("Failed to record the decision", error);
  }
});
