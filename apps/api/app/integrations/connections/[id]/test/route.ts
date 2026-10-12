import type { IntegrationConnectionTestResult } from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { denyUnlessOrgAdmin } from "../../route-helpers";

/**
 * POST /integrations/connections/{id}/test
 * Checks the stored credentials against the source system and records the
 * outcome on the connection. May have visible side effects (Microsoft Teams
 * posts a test card), so org admins only. A failed check is a 200 with
 * ok=false.
 */
export const POST = withAnyAuth<
  IntegrationConnectionTestResult,
  "/integrations/connections/[id]/test"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: "/integrations/connections/[id]/test",
    });
    if (denied) {
      return denied;
    }

    const { id } = await params;
    const result = await integrationConnectionService.test(
      auth.user.organizationId,
      id
    );
    if (!result) {
      return notFoundResponse("Integration connection");
    }
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to test integration connection", error);
  }
});
