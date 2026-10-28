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
  /** Local gateway port (loopback only); unset: any free port. */
  GatewayPort: "AGENTFLOW_RUNNER_GATEWAY_PORT",
  /**
   * When `true` (default), loop callbacks go to AGENTFLOW_API_URL instead of
   * the `apiBaseUrl` the API put in the command, which is often a URL only
   * the API host can reach (e.g. `http://localhost:3002`).
   */
  RewriteCallbackUrl: "AGENTFLOW_RUNNER_REWRITE_CALLBACK_URL",
  /**
   * Report every loop as an agent session and the runner's agent components
   * to AgentFlow's Sessions and Agents pages (default on; AgentFlow always
   * ingests them).
   */
  ReportSessions: "AGENTFLOW_RUNNER_REPORT_SESSIONS",
  /**
   * `auto` (default): loops clone the project repositories into the
   * workspace. `personal`: the runner works for one AgentFlow project, in a
   * folder of this computer, with this computer's credentials (docs/runner.md
   * "Personal runner").
   */
  Mode: "AGENTFLOW_RUNNER_MODE",
  /** Personal runner: the AgentFlow project key (its slug, e.g. `PRO-1`). */
  ProjectKey: "AGENTFLOW_RUNNER_PROJECT_KEY",
  /** Personal runner: the project folder loops run in. */
  ProjectDir: "AGENTFLOW_RUNNER_PROJECT_DIR",
  /**
   * Personal runner: `true` when the project's commands can run several
   * loops in the folder at once (they make their own worktrees); default
   * `false`, one loop at a time.
   */
  Parallel: "AGENTFLOW_RUNNER_PARALLEL",
  /**
   * Personal runner: `true` lets the agent use any tool without a permission
   * prompt (`--permission-mode bypassPermissions`); default `false`, the
   * loop's allowed tools plus the person's own `permissions.allow`.
   */
  SkipPermissions: "AGENTFLOW_RUNNER_SKIP_PERMISSIONS",
} as const;
export type HeadlessRunnerEnv =
  (typeof HeadlessRunnerEnv)[keyof typeof HeadlessRunnerEnv];

export const RUNNER_DATA_DIR_ENV = HeadlessRunnerEnv.DataDir;

export const RunnerMode = {
  Auto: "auto",
  Personal: "personal",
} as const;
export type RunnerMode = (typeof RunnerMode)[keyof typeof RunnerMode];

const DEFAULT_DATA_DIR_NAME = ".agentflow-runner";
/** Personal runners keep their data in `<data dir>/personal/<project key>`. */
const PERSONAL_DATA_DIR_NAME = "personal";
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The runner data directory: AGENTFLOW_RUNNER_DATA_DIR or ~/.agentflow-runner. */
export function resolveRunnerDataDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env[RUNNER_DATA_DIR_ENV]?.trim();
  return path.resolve(
    configured || path.join(os.homedir(), DEFAULT_DATA_DIR_NAME)
  );
}

/** A project key as stored and compared: trimmed, upper case. */
export function normalizeProjectKey(value: string): string | null {
  const key = value.trim().toUpperCase();
  return PROJECT_KEY_RE.test(key) ? key : null;
}

/**
 * The data directory of the personal runner of a project: one per project
 * key, so several personal runners on one computer never share their
 * identity, job store, loop tokens, status or config file.
 */
export function resolvePersonalRunnerDataDir(
  projectKey: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(
    resolveRunnerDataDir(env),
    PERSONAL_DATA_DIR_NAME,
    projectKey
  );
}
