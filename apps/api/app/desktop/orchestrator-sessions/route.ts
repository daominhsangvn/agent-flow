import type { IntegrationSessionGrant } from "@repo/api/src/types/integration-tools";
import { orchestratorSessionRequestSchema } from "@repo/api/src/types/orchestrator";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireComputeTargetId } from "../route-helpers";
import { desktopOrchestratorSessionService } from "./service";

const REQUEST_MAX_BYTES = 4096;

/**
 * The orchestrator's runner exchanges the turn it was asked to run for the
 * turn's tool session token (docs/orchestrator.md). Only the computer the
 * turn was sent to gets one.
 */
export const POST = withAnyAuth<
  IntegrationSessionGrant,
  "/desktop/orchestrator-sessions"
>(async ({ user, clerkUserId }, request) => {
  const { computeTargetId, response } = requireComputeTargetId(request);
  if (response) {
    return response;
  }
  const { body, errorResponse: invalid } = await parseBody(
    request,
    orchestratorSessionRequestSchema,
    { maxBytes: REQUEST_MAX_BYTES }
  );
  if (invalid || !body) {
    return invalid;
  }
  try {
    const result = await desktopOrchestratorSessionService.issue({
      organizationId: user.organizationId,
      userId: user.id,
      clerkUserId,
      computeTargetId,
      turnId: body.turnId,
    });
    if (result.ok) {
      return successResponse(result.value);
    }
    return result.error === Status.Forbidden
      ? forbiddenResponse()
      : notFoundResponse("Orchestrator turn");
  } catch (error) {
    return errorResponse("Failed to open the orchestrator's tools", error);
  }
});
