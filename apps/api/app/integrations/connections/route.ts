import {
  createIntegrationConnectionInputSchema,
  type IntegrationConnection,
  type IntegrationConnectionsResponse,
} from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { ADMIN_VIEWER } from "@/lib/integrations/connection/url-redaction";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import {
  CONNECTION_BODY_MAX_BYTES,
  connectionErrorResponse,
  denyUnlessOrgAdmin,
} from "./route-helpers";

const ROUTE = "/integrations/connections";

/**
 * GET /integrations/connections
 * Every integration connection of the organization. Org admins only:
 * connections carry the organization's integration settings.
 */
export const GET = withAnyAuth<
  IntegrationConnectionsResponse,
  "/integrations/connections"
>(async (auth, request) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }
    const connections = await integrationConnectionService.list(
      auth.user.organizationId,
      ADMIN_VIEWER
    );
    return successResponse({ connections });
  } catch (error) {
    return errorResponse("Failed to list integration connections", error);
  }
});

/**
 * POST /integrations/connections
 * Creates a connection after the provider validated its credentials (400 with
 * the provider message otherwise). Org admins only.
 */
export const POST = withAnyAuth<
  IntegrationConnection,
  "/integrations/connections"
>(async (auth, request) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createIntegrationConnectionInputSchema,
      { maxBytes: CONNECTION_BODY_MAX_BYTES }
    );
    if (parseError || !body) {
      return parseError;
    }

    const result = await integrationConnectionService.create(
      auth.user.organizationId,
      auth.user.id,
      body
    );
    if (!result.ok) {
      return connectionErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to create integration connection", error);
  }
});
