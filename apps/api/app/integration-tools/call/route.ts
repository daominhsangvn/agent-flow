import {
  INTEGRATION_TOOL_INPUT_MAX_BYTES,
  type IntegrationToolCallResponse,
  integrationToolCallRequestSchema,
} from "@repo/api/src/types/integration-tools";
import { Status } from "@repo/api/src/types/result";
import type { NextRequest } from "next/server";
import { integrationToolService } from "@/app/integration-tools/integration-tool-service";
import {
  errorResponse,
  getBearerToken,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * One integration tool call of an agent, forwarded by the MCP server
 * (apps/mcp). Authenticated by the session token alone; the answer carries a
 * refusal or a provider failure as `{ ok: false }` so the agent can read it.
 */
export async function POST(request: NextRequest) {
  const token = getBearerToken(request);
  const { body, errorResponse: invalid } = await parseBody(
    request,
    integrationToolCallRequestSchema,
    { maxBytes: INTEGRATION_TOOL_INPUT_MAX_BYTES }
  );
  if (invalid) {
    return invalid;
  }
  try {
    const result = await integrationToolService.call(token, body);
    if (result.ok) {
      return successResponse<IntegrationToolCallResponse>(result.value);
    }
    return result.error === Status.Unauthorized
      ? unauthorizedResponse()
      : notFoundResponse("Integration tool session");
  } catch (error) {
    return errorResponse("Failed to run the integration tool", error);
  }
}
