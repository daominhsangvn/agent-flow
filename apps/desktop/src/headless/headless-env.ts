/**
 * @file headless-env.ts
 * @description Environment variable names read by the headless runner
 * (src/headless/headless-main.ts). Kept dependency-free so the Electron shims
 * can import it without pulling in the runner composition.
 */

import os from "node:os";
import path from "node:path";

export const HeadlessRunnerEnv = {
  /** Origin of the AgentFlow API, e.g. `https://agentflow.example.com:3002`. */
  ApiUrl: "AGENTFLOW_API_URL",
  /** `sk_live_` API key with the `write` scope; the runner acts as its owner. */
  ApiKey: "AGENTFLOW_API_KEY",
  /** Origin of the web app; only used for links and gateway CORS. */
  WebAppUrl: "AGENTFLOW_WEB_APP_URL",
  /** Compute target name shown in AgentFlow. Defaults to the hostname. */
  RunnerName: "AGENTFLOW_RUNNER_NAME",
  /** Directory repositories are cloned into and loops work in. */
  Workspace: "AGENTFLOW_RUNNER_WORKSPACE",
  /** Directory for runner state (identity, job store, loop tokens). */
  DataDir: "AGENTFLOW_RUNNER_DATA_DIR",
  /** Commands executed at the same time (loops are long-running). */
  MaxConcurrent: "AGENTFLOW_RUNNER_MAX_CONCURRENT",
  /** Local gateway port (loopback only). */
  GatewayPort: "AGENTFLOW_RUNNER_GATEWAY_PORT",
  /**
   * When `true` (default), loop callbacks go to AGENTFLOW_API_URL instead of
   * the `apiBaseUrl` the API put in the command, which is often a URL only
   * the API host can reach (e.g. `http://localhost:3002`).
   */
  RewriteCallbackUrl: "AGENTFLOW_RUNNER_REWRITE_CALLBACK_URL",
  /**
   * Report every loop as an agent session and the runner's agent components
   * to AgentFlow's Sessions and Agents pages (default on; AgentFlow still
   * ingests them only when the organization allows session sync).
   */
  ReportSessions: "AGENTFLOW_RUNNER_REPORT_SESSIONS",
} as const;
export type HeadlessRunnerEnv =
  (typeof HeadlessRunnerEnv)[keyof typeof HeadlessRunnerEnv];

export const RUNNER_DATA_DIR_ENV = HeadlessRunnerEnv.DataDir;

const DEFAULT_DATA_DIR_NAME = ".agentflow-runner";

/** The runner data directory: AGENTFLOW_RUNNER_DATA_DIR or ~/.agentflow-runner. */
export function resolveRunnerDataDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env[RUNNER_DATA_DIR_ENV]?.trim();
  return path.resolve(
    configured || path.join(os.homedir(), DEFAULT_DATA_DIR_NAME)
  );
}
