import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import type { BinaryPaths } from "./binary-paths.js";
import {
  type GatewayHealthCheckResponse,
  runHealthCheck,
} from "./health-check.js";
import {
  type AgentFlowModelProvider,
  type AgentFlowModelProviderLookup,
  agentFlowModelProviderCheck,
  CLAUDE_AUTH_CHECK_ID,
} from "./health-check-claude-auth.js";
import type { McpDetectionResult } from "./mcp-detection.js";
import { json } from "./response-utils.js";

/**
 * The System Check of a headless runner: the desktop app's sweep
 * (`runHealthCheck`) with what does not apply to a runner taken out and what
 * only AgentFlow knows put in.
 *
 * - No MCP rows: a runner runs loops and health checks only, never the
 *   AgentFlow MCP server or Codex, so it does not probe for them and
 *   `mcpServers` is empty (the web then shows no MCP rows).
 * - Claude authentication: loops get the model provider set in AgentFlow
 *   (Settings → computers → Model provider) with every command, so when the
 *   runner has one the row says so and passes, whatever is on the runner's
 *   disk; without one (or when AgentFlow cannot be asked) the row stays what
 *   the runner found.
 */

/** What the host running the gateway changes about its System Check. */
export type SystemCheckHostOptions = {
  /** A headless runner: its System Check is `registerRunnerHealthCheckRoute`'s. */
  headlessRunner?: boolean;
  /** AgentFlow's model provider for this computer; absent when it cannot be asked. */
  getAgentFlowModelProvider?: AgentFlowModelProviderLookup;
};

/** A runner's System Check response: the MCP rows do not apply. */
export type RunnerHealthCheckResponse = Omit<
  GatewayHealthCheckResponse,
  "mcpServers"
> & {
  mcpServers: Record<string, never>;
};

export type RunnerHealthCheckRouteDeps = {
  processManager: ProcessManager;
  getSymphonyDir: () => string;
  getBinaryPaths?: () => BinaryPaths;
  getAppVersion: () => string | undefined;
  isPackagedBuild?: () => boolean;
  getAgentFlowModelProvider?: AgentFlowModelProviderLookup;
};

/**
 * Serves `GET /api/gateway/health-check` on a headless runner, in place of
 * the desktop app's route (`registerHealthCheckRoutes`).
 */
export function registerRunnerHealthCheckRoute(
  dispatcher: OperationDispatcher,
  deps: RunnerHealthCheckRouteDeps
): void {
  dispatcher.register("GET", HEALTH_CHECK_PATH, async (context) => {
    const response = await runHealthCheck({
      processManager: deps.processManager,
      configDir: () => path.join(deps.getSymphonyDir(), "config"),
      detectMcp: skipMcpDetection,
      paths: deps.getBinaryPaths?.(),
      requestedPluginAutoUpdate: context.query.get("pluginAutoUpdate") === "1",
      latestVersion: context.query.get("latestVersion")?.trim() || undefined,
      currentVersion: deps.getAppVersion(),
      isPackagedBuild: deps.isPackagedBuild,
    });
    json(
      context,
      200,
      await toRunnerHealthCheck(response, deps.getAgentFlowModelProvider)
    );
  });
}

/** The desktop sweep's response as a runner's (see the module comment). */
export async function toRunnerHealthCheck(
  response: GatewayHealthCheckResponse,
  getAgentFlowModelProvider: AgentFlowModelProviderLookup | undefined
): Promise<RunnerHealthCheckResponse> {
  const provider = await readAgentFlowModelProvider(getAgentFlowModelProvider);
  return {
    checks: provider
      ? response.checks.map((check) =>
          check.id === CLAUDE_AUTH_CHECK_ID
            ? agentFlowModelProviderCheck(provider)
            : check
        )
      : response.checks,
    allRequiredPassed: response.allRequiredPassed,
    mcpServers: {},
  };
}

/** The route the desktop app serves its System Check on, too. */
const HEALTH_CHECK_PATH = "/api/gateway/health-check";

/** A runner does not probe MCP servers; the result is dropped unread. */
function skipMcpDetection(): Promise<McpDetectionResult> {
  return Promise.resolve({
    available: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: new Date().toISOString(),
    agentflowAvailable: false,
  });
}

/** A lookup that fails (AgentFlow unreachable, an older API) reads as none. */
async function readAgentFlowModelProvider(
  lookup: AgentFlowModelProviderLookup | undefined
): Promise<AgentFlowModelProvider | null> {
  if (!lookup) {
    return null;
  }
  try {
    return await lookup();
  } catch {
    return null;
  }
}
