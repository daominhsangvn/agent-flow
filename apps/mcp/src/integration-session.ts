import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  INTEGRATION_MCP_SERVER_NAME,
  INTEGRATION_TOOLS_CALL_ROUTE,
  INTEGRATION_TOOLS_SESSION_ROUTE,
  type IntegrationToolCallResponse,
  type IntegrationToolSessionDescriptor,
} from "@repo/api/src/types/integration-tools.js";
import {
  ORCHESTRATOR_MCP_SERVER_NAME,
  ORCHESTRATOR_TOKEN_PREFIX,
  ORCHESTRATOR_TOOLS_CALL_ROUTE,
  ORCHESTRATOR_TOOLS_SESSION_ROUTE,
} from "@repo/api/src/types/orchestrator.js";

/**
 * Integration tool sessions (docs/workflows.md "Integration tools"): an
 * instruction's agent connects with an `ist_…` bearer token minted for its
 * runner. Such a session gets only the tools the API lists for that token,
 * with the API's server instructions, and none of the document or project
 * tools of API-key sessions. This server holds no credentials and checks
 * nothing itself: it forwards every call to the API, which authenticates the
 * token and re-checks the grant each time. Sessions are stateless (one server
 * per request), the descriptor cached per token for a minute.
 *
 * A project orchestrator's turn connects the same way with an `ost_…` token
 * (docs/orchestrator.md); its tool list and calls come from the API's
 * orchestrator tool routes instead.
 */

const INTEGRATION_TOKEN_RE = /^Bearer\s+((?:ist_|ost_)[A-Za-z0-9_-]{20,100})$/;
const DESCRIPTOR_TTL_MS = 60_000;
const DESCRIPTOR_CACHE_MAX = 500;
const REQUEST_TIMEOUT_MS = 30_000;
/** Writes reach providers (Jira, Teams…): allow them more time. */
const CALL_TIMEOUT_MS = 120_000;

export type IntegrationToolApi = {
  describe(token: string): Promise<IntegrationToolSessionDescriptor | null>;
  call(
    token: string,
    tool: string,
    input: Record<string, unknown>
  ): Promise<IntegrationToolCallResponse>;
};

/** The integration session token of an Authorization header, else null. */
export function extractIntegrationToken(
  authorization: string | null | undefined
): string | null {
  return INTEGRATION_TOKEN_RE.exec(authorization ?? "")?.[1] ?? null;
}

/** The API calls of an integration session, over HTTP. */
export function createIntegrationToolApi(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): IntegrationToolApi {
  const request = async (
    token: string,
    path: string,
    init: { method: string; body?: string; timeoutMs: number }
  ): Promise<Response> =>
    await fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  return {
    async describe(token) {
      const response = await request(token, routesFor(token).session, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response.status === 401 || response.status === 404) {
        return null;
      }
      return await readData<IntegrationToolSessionDescriptor>(response);
    },
    async call(token, tool, input) {
      const response = await request(token, routesFor(token).call, {
        method: "POST",
        body: JSON.stringify({ tool, input }),
        timeoutMs: CALL_TIMEOUT_MS,
      });
      if (response.status === 401 || response.status === 404) {
        return {
          ok: false,
          error:
            "This session has ended: the instruction or turn finished, was cancelled or was retried. Stop and answer.",
          retryable: false,
        };
      }
      return await readData<IntegrationToolCallResponse>(response);
    },
  };
}

/** The API of AGENTFLOW_API_URL, created on first use. */
export function defaultIntegrationToolApi(): IntegrationToolApi {
  defaultApi ??= createIntegrationToolApi(
    process.env.AGENTFLOW_API_URL ?? "http://localhost:3002"
  );
  return defaultApi;
}

let defaultApi: IntegrationToolApi | null = null;

/** An MCP server with exactly the session's tools, each forwarded to the API. */
export function createIntegrationMcpServer(
  token: string,
  descriptor: IntegrationToolSessionDescriptor,
  api: IntegrationToolApi
): Server {
  const server = new Server(
    {
      name: token.startsWith(ORCHESTRATOR_TOKEN_PREFIX)
        ? ORCHESTRATOR_MCP_SERVER_NAME
        : INTEGRATION_MCP_SERVER_NAME,
      version: "0.0.1",
    },
    { capabilities: { tools: {} }, instructions: descriptor.instructions }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: descriptor.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
      annotations: { title: tool.title, ...tool.annotations },
    })),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      try {
        const result = await api.call(
          token,
          request.params.name,
          request.params.arguments ?? {}
        );
        return result.ok
          ? { content: [{ type: "text", text: formatOutput(result.output) }] }
          : {
              content: [
                {
                  type: "text",
                  text: result.retryable
                    ? `${result.error} (temporary: you may try again once)`
                    : result.error,
                },
              ],
              isError: true,
            };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `AgentFlow could not run the tool: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
  return server;
}

/**
 * Handles one MCP request of an integration session: POST only (stateless,
 * no server-sent stream), answered by a server built for the token.
 */
export async function handleIntegrationMcpRequest(input: {
  req: IncomingMessage;
  res: ServerResponse;
  token: string;
  parsedBody: unknown;
  api: IntegrationToolApi;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}): Promise<void> {
  let descriptor: IntegrationToolSessionDescriptor | null;
  try {
    descriptor = await loadDescriptor(input.api, input.token);
  } catch {
    input.sendJson(input.res, 502, {
      error: "AgentFlow could not load the integration tools; try again.",
    });
    return;
  }
  if (!descriptor) {
    input.sendJson(input.res, 401, {
      error: "The integration session token is not valid (anymore).",
    });
    return;
  }
  const server = createIntegrationMcpServer(input.token, descriptor, input.api);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(input.req, input.res, input.parsedBody);
  } finally {
    await server.close();
  }
}

/** Clears the descriptor cache (tests). */
export function clearIntegrationDescriptorCache(): void {
  descriptors.clear();
}

const descriptors = new Map<
  string,
  { descriptor: IntegrationToolSessionDescriptor; expiresAt: number }
>();

async function loadDescriptor(
  api: IntegrationToolApi,
  token: string
): Promise<IntegrationToolSessionDescriptor | null> {
  const now = Date.now();
  const cached = descriptors.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.descriptor;
  }
  const descriptor = await api.describe(token);
  if (!descriptor) {
    descriptors.delete(token);
    return null;
  }
  for (const [key, entry] of descriptors) {
    if (entry.expiresAt <= now || descriptors.size >= DESCRIPTOR_CACHE_MAX) {
      descriptors.delete(key);
    }
  }
  descriptors.set(token, { descriptor, expiresAt: now + DESCRIPTOR_TTL_MS });
  return descriptor;
}

async function readData<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (
    response.ok &&
    body &&
    typeof body === "object" &&
    "data" in body &&
    body.data !== undefined
  ) {
    return body.data as T;
  }
  throw new Error(`AgentFlow API answered ${response.status}`);
}

function formatOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

/** The API routes a token's tools come from: an orchestrator turn's or an agent's. */
function routesFor(token: string): { session: string; call: string } {
  return token.startsWith(ORCHESTRATOR_TOKEN_PREFIX)
    ? {
        session: ORCHESTRATOR_TOOLS_SESSION_ROUTE,
        call: ORCHESTRATOR_TOOLS_CALL_ROUTE,
      }
    : {
        session: INTEGRATION_TOOLS_SESSION_ROUTE,
        call: INTEGRATION_TOOLS_CALL_ROUTE,
      };
}
