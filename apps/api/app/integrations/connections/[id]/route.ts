import {
  type IntegrationConnection,
  updateIntegrationConnectionInputSchema,
} from "@repo/api/src/types/integration";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  CONNECTION_BODY_MAX_BYTES,
  connectionErrorResponse,
  denyUnlessOrgAdmin,
  keepSubmittedFields,
  resolveConfigViewer,
} from "../route-helpers";

const ROUTE = "/integrations/connections/[id]";

/**
 * GET /integrations/connections/{id}
 * One connection (secrets only as isSet + last four). Any org member;
 * members who are not org admins see url-kind config fields as their origin
 * only.
 */
export const GET = withAnyAuth<
  IntegrationConnection,
  "/integrations/connections/[id]"
>(async (auth, _request, params) => {
  try {
    const { id } = await params;
    const connection = await integrationConnectionService.get(
      auth.user.organizationId,
      id,
      await resolveConfigViewer(auth)
    );
    if (!connection) {
      return notFoundResponse("Integration connection");
    }
    return successResponse(connection);
  } catch (error) {
    return errorResponse("Failed to load integration connection", error);
  }
});

/**
 * PATCH /integrations/connections/{id}
 * Updates a connection; re-validates with the provider when config or
 * secrets change. Org admins only.
 */
export const PATCH = withAnyAuth<
  IntegrationConnection,
  "/integrations/connections/[id]"
>(async (auth, request, params) => {
  try {
    const denied = await denyUnlessOrgAdmin(auth, {
      method: request.method,
      route: ROUTE,
    });
    if (denied) {
      return denied;
    }

    const {
      body,
      rawBody,
      errorResponse: parseError,
    } = await parseBody(request, updateIntegrationConnectionInputSchema, {
      maxBytes: CONNECTION_BODY_MAX_BYTES,
    });
    if (parseError || !body) {
      return parseError;
    }

    const { id } = await params;
    const result = await integrationConnectionService.update(
      auth.user.organizationId,
      id,
      keepSubmittedFields(body, rawBody)
    );
    if (!result.ok) {
      return connectionErrorResponse(result.error);
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to update integration connection", error);
  }
});

/**
 * DELETE /integrations/connections/{id}
 * 409 while a workflow trigger or action uses the connection. Org admins only.
 */
export const DELETE = withAnyAuth<
  { deleted: true },
  "/integrations/connections/[id]"
>(
  async (auth, request, params) => {
    try {
      const denied = await denyUnlessOrgAdmin(auth, {
        method: request.method,
        route: ROUTE,
      });
      if (denied) {
        return denied;
      }

      const { id } = await params;
      const result = await integrationConnectionService.remove(
        auth.user.organizationId,
        id
      );
      if (!result.ok) {
        return connectionErrorResponse(result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to delete integration connection", error);
    }
  },
  { requiredScopes: ["delete"] }
);
