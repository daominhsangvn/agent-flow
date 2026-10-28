import {
  type IntegrationSessionGrant,
  integrationSessionRequestSchema,
} from "@repo/api/src/types/integration-tools";
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
import { desktopIntegrationSessionService } from "./service";

/**
 * A runner exchanges the instruction action run it was asked to run for the
 * agent's integration tool session token (docs/workflows.md "Integration
 * tools"). Only the computer the attempt was dispatched to gets one.
 */
export const POST = withAnyAuth<
  IntegrationSessionGrant,
  "/desktop/integration-sessions"
>(async ({ user, clerkUserId }, request) => {
  const { computeTargetId, response } = requireComputeTargetId(request);
  if (response) {
    return response;
  }
  const { body, errorResponse: invalid } = await parseBody(
    request,
    integrationSessionRequestSchema,
    { maxBytes: REQUEST_MAX_BYTES }
  );
  if (invalid) {
    return invalid;
  }
  try {
    const result = await desktopIntegrationSessionService.issue({
      organizationId: user.organizationId,
      userId: user.id,
      clerkUserId,
      computeTargetId,
      request: body,
    });
    if (result.ok) {
      return successResponse(result.value);
    }
    return result.error === Status.Forbidden
      ? forbiddenResponse()
      : notFoundResponse("Integration tool session");
  } catch (error) {
    return errorResponse("Failed to open the integration tool session", error);
  }
});

const REQUEST_MAX_BYTES = 4096;
