/**
 * @file headless-main.ts
 * @description Entry point of the headless runner bundle
 * (`dist-headless/runner.mjs`, built by scripts/build-headless-runner.mjs).
 * Reads the configuration, checks the machine, connects to AgentFlow, and
 * shuts down cleanly on SIGTERM/SIGINT. See docs/runner.md.
 *
 *   node runner.mjs                       the auto runner (one per computer)
 *   node runner.mjs --project <key>       the personal runner of a project
 *   node runner.mjs setup [--project <key>]   asks the setup questions
 */

import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import { ClaudeCredentialSource } from "../server/claude-credentials.js";
import { configureClaudeCodeVersionInstaller } from "../server/operations/claude-code-version-pin.js";
import { configurePersonalRunnerProject } from "../server/operations/personal-runner.js";
import { isWindows } from "../server/platform-shell.js";
import { createClaudeCodeVersionCheck } from "./claude-code-version-check.js";
import { createClaudeCodeVersions } from "./claude-code-versions.js";
import {
  type HeadlessRunnerConfig,
  loadHeadlessConfig,
} from "./headless-config.js";
import {
  HeadlessRunnerEnv,
  normalizeProjectKey,
  RUNNER_DATA_DIR_ENV,
  RunnerMode,
  resolvePersonalRunnerDataDir,
  resolveRunnerDataDir,
} from "./headless-env.js";
import { acquireInstanceLock } from "./headless-instance-lock.js";
import {
  defaultPreflightDeps,
  fatalPreflightProblems,
  type PreflightReport,
  runHeadlessPreflight,
  toCapabilities,
} from "./headless-preflight.js";
import { type HeadlessRunner, startHeadlessRunner } from "./headless-runner.js";
import {
  applyRunnerConfig,
  askRunnerMode,
  askRunnerSettings,
  needsSetup,
  readRunnerConfigFile,
  runnerConfigFile,
  SETUP_SETTINGS,
  writeRunnerConfigFile,
} from "./headless-setup.js";
import {
  prepareWindowsTools,
  windowsToolOverrides,
} from "./headless-windows-tools.js";

const LOG_TAG = "headless-runner";
const EXIT_CONFIG_ERROR = 2;
const EXIT_PREFLIGHT_ERROR = 3;
const EXIT_RUNTIME_ERROR = 1;
const EXIT_INTERRUPTED = 130;
const SETUP_COMMAND = "setup";
/** `--project <key>`: the personal runner of that AgentFlow project. */
const PROJECT_OPTION = "--project";

type RunnerArgs = { setup: boolean; projectKey: string | null };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    gatewayLog.error(LOG_TAG, args.error);
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }
  let dataDir = instanceDataDir(args.value.projectKey);
  if (args.value.setup) {
    await runInteractiveSetup(dataDir, args.value.projectKey);
    return;
  }
  applyRunnerConfig(
    process.env,
    readRunnerConfigFile(runnerConfigFile(dataDir))
  );
  if (needsSetup(process.env) && process.stdin.isTTY) {
    dataDir = await runInteractiveSetup(dataDir, args.value.projectKey);
    applyRunnerConfig(
      process.env,
      readRunnerConfigFile(runnerConfigFile(dataDir))
    );
  }
  // The data directory of this instance: its config, identity and jobs.
  process.env[RUNNER_DATA_DIR_ENV] = dataDir;

  const config = loadInstanceConfig(dataDir, args.value.projectKey);
  if (!config) {
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }

  // Before the preflight: it reads PATH, which then starts with the shims.
  const executables = isWindows()
    ? windowsToolOverrides(await prepareWindowsTools(config.dataDir))
    : {};
  const report = await runHeadlessPreflight(
    config.workspaceDir,
    defaultPreflightDeps(executables)
  );
  logPreflight(report);
  const problems = fatalPreflightProblems(report);
  if (problems.length > 0) {
    for (const problem of problems) {
      gatewayLog.error(LOG_TAG, `Cannot start: ${problem}`);
    }
    process.exitCode = EXIT_PREFLIGHT_ERROR;
    return;
  }

  await setUpClaudeCode(config, report);
  const runner = await startHeadlessRunner(config, toCapabilities(report));
  installShutdownHandlers(runner);
}

/** `[setup] [--project <key>]`. */
function parseArgs(
  argv: readonly string[]
): { ok: true; value: RunnerArgs } | { ok: false; error: string } {
  const value: RunnerArgs = { setup: false, projectKey: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === SETUP_COMMAND && index === 0) {
      value.setup = true;
      continue;
    }
    if (arg === PROJECT_OPTION) {
      const key = normalizeProjectKey(argv[index + 1] ?? "");
      if (!key) {
        return {
          ok: false,
          error: `${PROJECT_OPTION} needs an AgentFlow project key, e.g. ${PROJECT_OPTION} PRO-1`,
        };
      }
      value.projectKey = key;
      index++;
      continue;
    }
    return {
      ok: false,
      error: `Unknown argument "${arg}": run without arguments (auto runner), with "${PROJECT_OPTION} <project key>" (personal runner), or "${SETUP_COMMAND}"`,
    };
  }
  return { ok: true, value };
}

/** The default data directory, or the personal one of the project. */
function instanceDataDir(projectKey: string | null): string {
  return projectKey
    ? resolvePersonalRunnerDataDir(projectKey)
    : resolveRunnerDataDir();
}

/** `--project` starts the personal runner of that project, and nothing else. */
function checkInstanceMode(
  config: HeadlessRunnerConfig,
  projectKey: string | null
): string | null {
  if (!projectKey) {
    return null;
  }
  if (!config.personal) {
    return `${PROJECT_OPTION} ${projectKey} starts a personal runner, but its configuration is not personal: run "node runner.mjs ${SETUP_COMMAND} ${PROJECT_OPTION} ${projectKey}"`;
  }
  return config.personal.projectKey === projectKey
    ? null
    : `${PROJECT_OPTION} ${projectKey} does not match the configured project key ${config.personal.projectKey}`;
}

/**
 * The instance's configuration, once it is valid, matches `--project`, and
 * this process holds the data directory's lock; null (errors logged)
 * otherwise. Configures the personal runner's project.
 */
function loadInstanceConfig(
  dataDir: string,
  projectKey: string | null
): HeadlessRunnerConfig | null {
  const loaded = loadHeadlessConfig();
  if (!loaded.ok) {
    for (const error of loaded.errors) {
      gatewayLog.error(LOG_TAG, `Invalid configuration: ${error}`);
    }
    const setup = projectKey
      ? `${SETUP_COMMAND} ${PROJECT_OPTION} ${projectKey}`
      : SETUP_COMMAND;
    gatewayLog.error(
      LOG_TAG,
      `Configure the runner with "node runner.mjs ${setup}" (saved to ${runnerConfigFile(dataDir)}) or environment variables (docs/runner.md).`
    );
    return null;
  }
  const { config } = loaded;
  const modeError = checkInstanceMode(config, projectKey);
  if (modeError) {
    gatewayLog.error(LOG_TAG, modeError);
    return null;
  }
  const instance = acquireInstanceLock(config.dataDir);
  if (!instance.ok) {
    gatewayLog.error(LOG_TAG, `Cannot start: ${instance.error}`);
    return null;
  }
  process.on("exit", () => instance.lock.release());
  if (config.personal) {
    configurePersonalRunnerProject(config.personal);
    gatewayLog.info(
      LOG_TAG,
      `Personal runner of project ${config.personal.projectKey}: loops run in ${config.personal.projectDir} with this computer's credentials, ${config.personal.parallel ? "several at once" : "one at a time"}`
    );
  } else {
    fs.mkdirSync(config.workspaceDir, { recursive: true });
  }
  return config;
}

/** The Claude Code version set in AgentFlow, where the runner may pin one. */
async function setUpClaudeCode(
  config: HeadlessRunnerConfig,
  report: PreflightReport
): Promise<void> {
  if (config.personal) {
    // The person's own Claude Code: pinning repoints ~/.local/bin/claude,
    // which every runner and terminal of this account shares.
    gatewayLog.info(
      LOG_TAG,
      "Personal runner: loops run the claude on PATH (no version pinning); a loop fails when the provider pins another Claude Code version"
    );
    const claudePath = report.tools.find(
      (tool) => tool.name === LoopHarness.Claude
    )?.path;
    if (claudePath) {
      configureClaudeCodeVersionInstaller(
        createClaudeCodeVersionCheck({
          claudePath,
          homeDir: os.homedir(),
          log: { warn: (message) => gatewayLog.warn(LOG_TAG, message) },
        })
      );
    }
  } else if (isWindows()) {
    // Versions are installed as symlinked binaries, which Windows does not
    // allow an ordinary account to create.
    gatewayLog.info(
      LOG_TAG,
      "Claude Code version pinning is not supported on Windows; loops run the claude on PATH"
    );
  } else {
    await setUpClaudeCodeVersions(config.dataDir, report);
  }
}

/**
 * Asks the setup questions in this terminal and saves the answers to the
 * data directory of the chosen instance, which it returns: the default one
 * for the auto runner, the project's own for a personal runner.
 */
async function runInteractiveSetup(
  dataDir: string,
  projectKey: string | null
): Promise<string> {
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Without a listener, Ctrl+C only pauses the prompt.
  prompt.on("SIGINT", () => {
    prompt.close();
    process.exit(EXIT_INTERRUPTED);
  });
  // Read through the iterator, not prompt.question(): it keeps lines that
  // arrive before their question (answers piped in) and ends on end of input.
  const lines = prompt[Symbol.asyncIterator]();
  const say = (line: string) => {
    process.stdout.write(`${line}\n`);
  };
  try {
    const fromFile = readRunnerConfigFile(runnerConfigFile(dataDir));
    const current: Record<string, string | undefined> = {};
    for (const name of SETUP_SETTINGS) {
      current[name] = process.env[name]?.trim() || fromFile[name];
    }
    say("AgentFlow runner setup. Press Enter to keep the value in brackets.");
    const context = {
      ask: async (question: string, shownDefault?: string) => {
        process.stdout.write(
          shownDefault ? `${question} [${shownDefault}]: ` : `${question}: `
        );
        const line = await lines.next();
        if (line.done) {
          throw new Error(
            "Setup input ended before every question was answered"
          );
        }
        return line.value.trim();
      },
      say,
      current,
      username: currentUsername(),
      homeDir: os.homedir(),
    };
    const mode = projectKey
      ? RunnerMode.Personal
      : await askRunnerMode(context);
    const answers = await askRunnerSettings(context, mode);
    const answeredKey = answers[HeadlessRunnerEnv.ProjectKey];
    const targetDir =
      mode === RunnerMode.Personal && answeredKey
        ? resolvePersonalRunnerDataDir(answeredKey)
        : resolveRunnerDataDir();
    const configFile = runnerConfigFile(targetDir);
    writeRunnerConfigFile(configFile, answers);
    say(`Saved to ${configFile}`);
    if (mode === RunnerMode.Personal && answeredKey) {
      say(
        `Start this personal runner with: start-runner ${PROJECT_OPTION} ${answeredKey} (node runner.mjs ${PROJECT_OPTION} ${answeredKey})`
      );
    }
    return targetDir;
  } finally {
    prompt.close();
  }
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "";
  }
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

/**
 * Loops install and run the Claude Code version set for this computer in
 * AgentFlow; after a restart `claude` points at the last one again (a
 * recreated container loses ~/.local/bin, not the versions volume).
 */
async function setUpClaudeCodeVersions(
  dataDir: string,
  report: PreflightReport
): Promise<void> {
  const claudePath = report.tools.find(
    (tool) => tool.name === LoopHarness.Claude
  )?.path;
  if (!claudePath) {
    return;
  }
  const versions = createClaudeCodeVersions({
    homeDir: os.homedir(),
    dataDir,
    // The binary itself, not ~/.local/bin/claude, which each version change
    // repoints.
    installerPath: realpathOrSelf(claudePath),
    log: {
      info: (message) => gatewayLog.info(LOG_TAG, message),
      warn: (message) => gatewayLog.warn(LOG_TAG, message),
    },
  });
  try {
    const restored = await versions.restore();
    if (restored) {
      gatewayLog.info(
        LOG_TAG,
        `Claude Code ${restored.version} (set in AgentFlow): ${restored.binaryPath}`
      );
    }
  } catch (error) {
    gatewayLog.warn(
      LOG_TAG,
      `Could not restore the Claude Code version set in AgentFlow: ${String(error)}`
    );
  }
  configureClaudeCodeVersionInstaller(versions);
}

function realpathOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

main().catch((error: unknown) => {
  gatewayLog.error(
    LOG_TAG,
    `Runner crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  );
  process.exit(EXIT_RUNTIME_ERROR);
});
