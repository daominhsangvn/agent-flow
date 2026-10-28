import type { IntegrationToolSessionDescriptor } from "@repo/api/src/types/integration-tools";
import type { NextRequest } from "next/server";
import { orchestratorToolService } from "@/app/orchestrator-tools/service";
import {
  errorResponse,
  getBearerToken,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * The tools and server instructions of an orchestrator turn, for the MCP
 * server (apps/mcp). Authenticated by the turn's token alone.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await orchestratorToolService.describe(
      getBearerToken(request)
    );
    return result.ok
      ? successResponse<IntegrationToolSessionDescriptor>(result.value)
      : unauthorizedResponse();
  } catch (error) {
    return errorResponse("Failed to load the orchestrator's tools", error);
  }
}
