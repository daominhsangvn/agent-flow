/**
 * @file headless-main.ts
 * @description Entry point of the headless runner bundle
 * (`dist-headless/runner.mjs`, built by scripts/build-headless-runner.mjs).
 * Reads the configuration, checks the machine, connects to AgentFlow, and
 * shuts down cleanly on SIGTERM/SIGINT. See docs/runner.md.
 */

import fs from "node:fs";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import { ClaudeCredentialSource } from "../server/claude-credentials.js";
import { loadHeadlessConfig } from "./headless-config.js";
import { RUNNER_DATA_DIR_ENV } from "./headless-env.js";
import {
  fatalPreflightProblems,
  type PreflightReport,
  runHeadlessPreflight,
  toCapabilities,
} from "./headless-preflight.js";
import { type HeadlessRunner, startHeadlessRunner } from "./headless-runner.js";

const LOG_TAG = "headless-runner";
const EXIT_CONFIG_ERROR = 2;
const EXIT_PREFLIGHT_ERROR = 3;
const EXIT_RUNTIME_ERROR = 1;

async function main(): Promise<void> {
  const loaded = loadHeadlessConfig();
  if (!loaded.ok) {
    for (const error of loaded.errors) {
      gatewayLog.error(LOG_TAG, `Invalid configuration: ${error}`);
    }
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }
  const { config } = loaded;
  // The Electron-store and Electron shims resolve their files from here.
  process.env[RUNNER_DATA_DIR_ENV] = config.dataDir;
  fs.mkdirSync(config.workspaceDir, { recursive: true });

  const report = await runHeadlessPreflight(config.workspaceDir);
  logPreflight(report);
  const problems = fatalPreflightProblems(report);
  if (problems.length > 0) {
    for (const problem of problems) {
      gatewayLog.error(LOG_TAG, `Cannot start: ${problem}`);
    }
    process.exitCode = EXIT_PREFLIGHT_ERROR;
    return;
  }

  const runner = await startHeadlessRunner(config, toCapabilities(report));
  installShutdownHandlers(runner);
}

function logPreflight(report: PreflightReport): void {
  for (const tool of report.tools) {
    gatewayLog.info(
      LOG_TAG,
      tool.path
        ? `${tool.name}: ${tool.version ?? "version unknown"} (${tool.path})`
        : `${tool.name}: not found`
    );
  }
  gatewayLog.info(LOG_TAG, `plugins: ${report.pluginsDir ?? "not found"}`);
  gatewayLog.info(LOG_TAG, `Claude credentials: ${report.claudeCredentials}`);
  if (report.claudeCredentials === ClaudeCredentialSource.None) {
    gatewayLog.warn(
      LOG_TAG,
      "No Claude credentials on this runner. Set a model provider for this computer in AgentFlow (Settings → Compute & Integrations → Model provider), or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY here."
    );
  }
  for (const tool of report.missingRecommended) {
    gatewayLog.warn(
      LOG_TAG,
      `${tool} not found; loops cannot open pull requests`
    );
  }
}

function installShutdownHandlers(runner: HeadlessRunner): void {
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    gatewayLog.info(LOG_TAG, `Received ${signal}, stopping`);
    runner.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        gatewayLog.error(LOG_TAG, `Shutdown failed: ${String(error)}`);
        process.exit(EXIT_RUNTIME_ERROR);
      }
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  gatewayLog.error(
    LOG_TAG,
    `Runner crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  );
  process.exit(EXIT_RUNTIME_ERROR);
});
