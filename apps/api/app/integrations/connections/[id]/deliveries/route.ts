import type { IntegrationDeliveriesResponse } from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { ADMIN_VIEWER } from "@/lib/integrations/connection/url-redaction";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { denyUnlessOrgAdmin } from "../../route-helpers";

/**
 * GET /integrations/connections/{id}/deliveries
 * The latest 50 inbound deliveries of a connection. Org admins only.
 */
export const GET = withAnyAuth<
  IntegrationDeliveriesResponse,
  "/integrations/connections/[id]/deliveries"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: "/integrations/connections/[id]/deliveries",
    });
    if (denied) {
      return denied;
    }
    const { user } = auth;
    const { id } = await params;
    // Existence check only; the connection itself is not returned.
    const connection = await integrationConnectionService.get(
      user.organizationId,
      id,
      ADMIN_VIEWER
    );
    if (!connection) {
      return notFoundResponse("Integration connection");
    }
    const deliveries = await integrationConnectionService.listDeliveries(
      user.organizationId,
      id
    );
    return successResponse({ deliveries });
  } catch (error) {
    return errorResponse("Failed to list integration deliveries", error);
  }
});
