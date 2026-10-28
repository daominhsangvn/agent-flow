import type { IntegrationToolSessionDescriptor } from "@repo/api/src/types/integration-tools";
import { Status } from "@repo/api/src/types/result";
import type { NextRequest } from "next/server";
import { integrationToolService } from "@/app/integration-tools/integration-tool-service";
import {
  errorResponse,
  getBearerToken,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * The tools and server instructions of an integration tool session, for the
 * MCP server (apps/mcp). Authenticated by the session token alone.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await integrationToolService.describe(
      getBearerToken(request)
    );
    if (result.ok) {
      return successResponse<IntegrationToolSessionDescriptor>(result.value);
    }
    return result.error === Status.Unauthorized
      ? unauthorizedResponse()
      : notFoundResponse("Integration tool session");
  } catch (error) {
    return errorResponse("Failed to load the integration tools", error);
  }
}
