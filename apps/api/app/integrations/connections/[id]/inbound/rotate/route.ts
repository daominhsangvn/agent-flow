import type { IntegrationInboundDetails } from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { denyUnlessOrgAdmin } from "../../../route-helpers";

/**
 * POST /integrations/connections/{id}/inbound/rotate
 * Issues a new inbound key and secret; the previous URL and secret stop
 * working immediately. Org admins only.
 */
export const POST = withAnyAuth<
  IntegrationInboundDetails,
  "/integrations/connections/[id]/inbound/rotate"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: "/integrations/connections/[id]/inbound/rotate",
    });
    if (denied) {
      return denied;
    }

    const { id } = await params;
    const details = await integrationConnectionService.rotateInbound(
      auth.user.organizationId,
      id
    );
    if (!details) {
      return notFoundResponse("Integration connection");
    }
    return successResponse(details);
  } catch (error) {
    return errorResponse("Failed to rotate inbound endpoint", error);
  }
});
