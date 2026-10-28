import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INTEGRATION_ATTACH_COMMAND_ENV,
  INTEGRATION_FILE_NAME_HEADER,
  INTEGRATION_FILES_URL_ENV,
  INTEGRATION_MCP_SERVER_NAME,
  INTEGRATION_SESSION_ROUTE,
  INTEGRATION_TOOL_TOKEN_ENV,
  INTEGRATION_TOOLS_FILES_ROUTE,
  type IntegrationSessionGrant,
} from "@repo/api/src/types/integration-tools";
import {
  ORCHESTRATOR_MCP_SERVER_NAME,
  ORCHESTRATOR_SESSION_ROUTE,
  ORCHESTRATOR_TOKEN_PREFIX,
} from "@repo/api/src/types/orchestrator";
import { z } from "zod";

/**
 * Integration tools of an agent (docs/workflows.md "Integration tools"): this
 * computer exchanges the instruction action run it was asked to run for the
 * agent's session token, authenticated with its own API key (the API hands
 * one only to the computer the attempt was dispatched to), or a STEP loop
 * with the loop's own runner token.
 * `AGENTFLOW_MCP_URL` replaces the MCP endpoint the API names when the
 * runner reaches it under another address (a container network). The
 * upload URL for comment attachments is the API this computer asked, so it
 * is reachable from here.
 */

export type OpenIntegrationSession = (
  actionRunId: string
) => Promise<IntegrationSessionGrant>;

export function createIntegrationSessionOpener(input: {
  getApiOrigin: () => string;
  getApiKey: () => string | null;
  getComputeTargetId: () => string | null;
  fetchImpl?: typeof fetch;
  mcpUrlOverride?: string;
}): OpenIntegrationSession {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (actionRunId) => {
    const apiKey = input.getApiKey();
    const computeTargetId = input.getComputeTargetId();
    if (!(apiKey && computeTargetId)) {
      throw new Error("this computer is not connected to AgentFlow");
    }
    const origin = input.getApiOrigin().replace(TRAILING_SLASHES_RE, "");
    const url = new URL(`${origin}${INTEGRATION_SESSION_ROUTE}`);
    url.searchParams.set("computeTargetId", computeTargetId);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actionRunId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return withFilesUrl(
      withMcpUrlOverride(await readGrant(response), input.mcpUrlOverride),
      origin
    );
  };
}

/** The opener of a gateway with an API connection, else undefined. */
export function integrationSessionOpenerFor(options: {
  getApiOrigin?: () => string;
  getApiKey?: () => string | null;
  getComputeTargetId?: () => string | null;
}): OpenIntegrationSession | undefined {
  const { getApiOrigin, getApiKey, getComputeTargetId } = options;
  return getApiOrigin && getApiKey && getComputeTargetId
    ? createIntegrationSessionOpener({
        getApiOrigin,
        getApiKey,
        getComputeTargetId,
      })
    : undefined;
}

/** A STEP loop's session, asked with the loop-runner token. */
export async function openLoopIntegrationSession(input: {
  apiBaseUrl: string;
  loopId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationSessionGrant> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = input.apiBaseUrl.replace(TRAILING_SLASHES_RE, "");
  const response = await fetchImpl(
    `${origin}/loops/${encodeURIComponent(input.loopId)}/integration-session`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  return withFilesUrl(
    withMcpUrlOverride(await readGrant(response), undefined),
    origin
  );
}

/**
 * The agent's environment for its integration tools: the token, and with an
 * upload helper the upload URL and the helper's path.
 */
export function integrationToolEnv(
  grant: Pick<IntegrationSessionGrant, "token" | "filesUrl">,
  attachHelper: string | null
): Record<string, string> {
  return {
    [INTEGRATION_TOOL_TOKEN_ENV]: grant.token,
    ...(grant.filesUrl && attachHelper
      ? {
          [INTEGRATION_FILES_URL_ENV]: grant.filesUrl,
          [INTEGRATION_ATTACH_COMMAND_ENV]: attachHelper,
        }
      : {}),
  };
}

export const ATTACH_HELPER_FILE = "agentflow-attach.sh";

/**
 * Writes the upload helper (`"$AGENTFLOW_ATTACH" <file> [content-type]`)
 * into the agent's folder and returns its path. It reads the token and the
 * URL from the agent's environment, so neither is written to disk.
 */
export async function writeAttachHelper(dir: string): Promise<string> {
  const file = path.join(dir, ATTACH_HELPER_FILE);
  await writeFile(file, ATTACH_HELPER_SCRIPT, "utf8");
  await chmod(file, 0o755);
  return file;
}

const ATTACH_HELPER_SCRIPT = `#!/bin/sh
# Attaches a file to the run's source item for a comment (AgentFlow
# integration tools) and prints the answer: {"success":true,"data":{"ok":true,
# "output":{"id":...}}}. Pass data.output.id in source_item_comment attachments.
set -eu
if [ "$#" -lt 1 ] || [ ! -f "$1" ]; then
  echo 'usage: "$${INTEGRATION_ATTACH_COMMAND_ENV}" <file> [content-type]' >&2
  exit 2
fi
type="\${2:-}"
if [ -z "$type" ]; then
  type=$(file -b --mime-type "$1" 2>/dev/null || true)
fi
name=$(printf %s "$(basename "$1")" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')
exec curl -sS -X POST "\${${INTEGRATION_FILES_URL_ENV}}" \\
  -H "Authorization: Bearer \${${INTEGRATION_TOOL_TOKEN_ENV}}" \\
  -H "Content-Type: \${type:-application/octet-stream}" \\
  -H "${INTEGRATION_FILE_NAME_HEADER}: $name" \\
  --data-binary "@$1"
`;

/**
 * The agent's MCP config: only the AgentFlow integration tools, the token
 * read from the agent's environment (Claude Code expands it).
 */
export function integrationMcpConfig(mcpUrl: string): object {
  return {
    mcpServers: {
      [INTEGRATION_MCP_SERVER_NAME]: {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer \${${INTEGRATION_TOOL_TOKEN_ENV}}`,
        },
      },
    },
  };
}

/**
 * The project orchestrator's runner exchanges a turn it was asked to run for
 * the turn's tool session (docs/orchestrator.md), like an instruction's.
 */
export type OpenOrchestratorSession = (
  turnId: string
) => Promise<IntegrationSessionGrant>;

export function orchestratorSessionOpenerFor(options: {
  getApiOrigin?: () => string;
  getApiKey?: () => string | null;
  getComputeTargetId?: () => string | null;
}): OpenOrchestratorSession | undefined {
  const { getApiOrigin, getApiKey, getComputeTargetId } = options;
  if (!(getApiOrigin && getApiKey && getComputeTargetId)) {
    return undefined;
  }
  return async (turnId) => {
    const apiKey = getApiKey();
    const computeTargetId = getComputeTargetId();
    if (!(apiKey && computeTargetId)) {
      throw new Error("this computer is not connected to AgentFlow");
    }
    const origin = getApiOrigin().replace(TRAILING_SLASHES_RE, "");
    const url = new URL(`${origin}${ORCHESTRATOR_SESSION_ROUTE}`);
    url.searchParams.set("computeTargetId", computeTargetId);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ turnId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return withMcpUrlOverride(
      await readGrant(response, ORCHESTRATOR_TOKEN_PREFIX),
      undefined
    );
  };
}

/** The orchestrator's MCP server, its token read from the agent's environment. */
export function orchestratorMcpConfig(mcpUrl: string): object {
  return {
    mcpServers: {
      [ORCHESTRATOR_MCP_SERVER_NAME]: {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer \${${INTEGRATION_TOOL_TOKEN_ENV}}`,
        },
      },
    },
  };
}

const REQUEST_TIMEOUT_MS = 15_000;
const TRAILING_SLASHES_RE = /\/+$/;

function grantResponseSchema(tokenPrefix: string) {
  return z.object({
    data: z.object({
      token: z.string().startsWith(tokenPrefix),
      expiresAt: z.string(),
      mcpUrl: z.url(),
    }),
  });
}

async function readGrant(
  response: Response,
  tokenPrefix = "ist_"
): Promise<IntegrationSessionGrant> {
  if (!response.ok) {
    throw new Error(`AgentFlow answered ${response.status}`);
  }
  const parsed = grantResponseSchema(tokenPrefix).safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) {
    throw new Error("AgentFlow answered without a session token");
  }
  return parsed.data.data;
}

function withMcpUrlOverride(
  grant: IntegrationSessionGrant,
  override: string | undefined
): IntegrationSessionGrant {
  const url = override ?? process.env.AGENTFLOW_MCP_URL;
  return url ? { ...grant, mcpUrl: url } : grant;
}

function withFilesUrl(
  grant: IntegrationSessionGrant,
  apiOrigin: string
): IntegrationSessionGrant {
  return { ...grant, filesUrl: `${apiOrigin}${INTEGRATION_TOOLS_FILES_ROUTE}` };
}
