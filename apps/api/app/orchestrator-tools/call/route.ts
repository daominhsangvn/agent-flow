import {
  INTEGRATION_TOOL_INPUT_MAX_BYTES,
  type IntegrationToolCallResponse,
  integrationToolCallRequestSchema,
} from "@repo/api/src/types/integration-tools";
import type { NextRequest } from "next/server";
import { orchestratorToolService } from "@/app/orchestrator-tools/service";
import {
  errorResponse,
  getBearerToken,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * Runs one tool of an orchestrator turn for the MCP server (apps/mcp).
 * Authenticated by the turn's token alone.
 */
export async function POST(request: NextRequest) {
  const { body, errorResponse: invalid } = await parseBody(
    request,
    integrationToolCallRequestSchema,
    { maxBytes: INTEGRATION_TOOL_INPUT_MAX_BYTES }
  );
  if (invalid || !body) {
    return invalid;
  }
  try {
    const result = await orchestratorToolService.call(
      getBearerToken(request),
      body.tool,
      body.input
    );
    return result.ok
      ? successResponse<IntegrationToolCallResponse>(result.value)
      : unauthorizedResponse();
  } catch (error) {
    return errorResponse("Failed to run the orchestrator's tool", error);
  }
}
