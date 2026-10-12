import type { IntegrationInboundDetails } from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { denyUnlessOrgAdmin } from "../../route-helpers";

/**
 * GET /integrations/connections/{id}/inbound
 * Inbound URL, shared secret and provider setup instructions. Returns a
 * secret, so org admins only.
 */
export const GET = withAnyAuth<
  IntegrationInboundDetails,
  "/integrations/connections/[id]/inbound"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: "/integrations/connections/[id]/inbound",
    });
    if (denied) {
      return denied;
    }

    const { id } = await params;
    const details = await integrationConnectionService.getInboundDetails(
      auth.user.organizationId,
      id
    );
    if (!details) {
      return notFoundResponse("Integration connection");
    }
    return successResponse(details);
  } catch (error) {
    return errorResponse("Failed to load inbound details", error);
  }
});
