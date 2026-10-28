import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { CheckSeverity } from "@agentflow-ai/loops-api/compute-target";
import {
  ClaudeCredentialSource,
  detectClaudeCredentialSource,
} from "../claude-credentials.js";
import { getShellEnv } from "../shell-path.js";
import type { GatewayCheckResult } from "./health-check-types.js";

/**
 * System Check row "Claude authentication": whether Claude Code on this
 * computer has a credential (an account login, an API key, a setup token or
 * an Anthropic-compatible endpoint token).
 *
 * Not required: a computer without one can still run loops when its model
 * provider is set in AgentFlow (Settings → computers → Model provider),
 * which sends the endpoint and token with each loop. A headless runner asks
 * AgentFlow for that provider and reports it in this row instead
 * (`agentFlowModelProviderCheck`, health-check-runner.ts).
 */

export const CLAUDE_AUTH_CHECK_ID = "claude-auth";
const CLAUDE_AUTH_CHECK_LABEL = "Claude authentication";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 3000;
const execFileAsync = promisify(execFile);

export type ClaudeAuthCheckDeps = {
  getEnv: () => Promise<Record<string, string | undefined>>;
  fileExists: (filePath: string) => boolean;
  platform: NodeJS.Platform;
  hasKeychainCredential: () => Promise<boolean>;
};

export async function checkClaudeAuth(
  deps: ClaudeAuthCheckDeps = defaultDeps()
): Promise<GatewayCheckResult> {
  let source = detectClaudeCredentialSource({
    env: await deps.getEnv(),
    fileExists: deps.fileExists,
  });
  if (
    source === ClaudeCredentialSource.None &&
    deps.platform === "darwin" &&
    (await deps.hasKeychainCredential())
  ) {
    source = ClaudeCredentialSource.Keychain;
  }
  if (source !== ClaudeCredentialSource.None) {
    return {
      id: CLAUDE_AUTH_CHECK_ID,
      label: CLAUDE_AUTH_CHECK_LABEL,
      required: false,
      passed: true,
      version: source,
      severity: CheckSeverity.Passed,
    };
  }
  return {
    id: CLAUDE_AUTH_CHECK_ID,
    label: CLAUDE_AUTH_CHECK_LABEL,
    required: false,
    passed: false,
    severity: CheckSeverity.Warning,
    error: "No Claude credential found on this computer",
    remediation:
      "Run `claude` and sign in (or `claude setup-token` for a long-lived token), set ANTHROPIC_API_KEY, or set a model provider for this computer in AgentFlow under Settings → Compute & Integrations.",
  };
}

function defaultDeps(): ClaudeAuthCheckDeps {
  return {
    getEnv: () => getShellEnv(),
    fileExists: existsSync,
    platform: process.platform,
    hasKeychainCredential: hasMacKeychainCredential,
  };
}

/** `security` exits 0 when the keychain holds Claude Code's login credential. */
async function hasMacKeychainCredential(): Promise<boolean> {
  try {
    await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE],
      { timeout: KEYCHAIN_TIMEOUT_MS }
    );
    return true;
  } catch {
    return false;
  }
}

/** The model provider AgentFlow sends with each loop to this computer. */
export type AgentFlowModelProvider = {
  /** Host of the provider's base URL, e.g. `api.deepseek.com`. */
  host: string;
};

/**
 * Asks AgentFlow for this computer's model provider: null when it uses the
 * computer's own Claude account.
 */
export type AgentFlowModelProviderLookup =
  () => Promise<AgentFlowModelProvider | null>;

/**
 * The row when loops on this computer get Claude credentials from AgentFlow's
 * model provider, which takes precedence over a credential on the computer.
 */
export function agentFlowModelProviderCheck(
  provider: AgentFlowModelProvider
): GatewayCheckResult {
  return {
    id: CLAUDE_AUTH_CHECK_ID,
    label: CLAUDE_AUTH_CHECK_LABEL,
    required: false,
    passed: true,
    version: `AgentFlow model provider (${provider.host})`,
    severity: CheckSeverity.Passed,
  };
}
