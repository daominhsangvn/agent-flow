/**
 * @file headless-preflight.ts
 * @description Startup checks for the headless runner: the CLIs an agent loop
 * needs, the vendored plugins, the workspace, and Claude credentials. Results
 * feed the compute target capabilities and a startup log, so a misconfigured
 * image is obvious before the first loop fails.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import {
  type ClaudeCredentialSource,
  detectClaudeCredentialSource,
} from "../server/claude-credentials.js";
import { getBundledPluginsRoot } from "../server/operations/bundled-plugins.js";
import {
  getShellPath,
  resolveExecutablesOnPath,
} from "../server/shell-path.js";
import type {
  CapabilityToolName,
  ComputeTargetCapabilities,
} from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;
const FIRST_LINE_RE = /^[^\n]*/;

/** CLIs a loop cannot run without (run-loop.sh and the plugins call them). */
export const REQUIRED_TOOLS = [
  "bash",
  "git",
  "claude",
  "jq",
  "python3",
] as const;
/** CLIs whose absence breaks part of a loop (opening the pull request). */
export const RECOMMENDED_TOOLS = ["gh"] as const;
/**
 * Language toolchains a project's repositories may need (a project runs only
 * on runners that have all of them). Reported, never required: the image
 * installs what its projects use.
 */
export const TOOLCHAIN_TOOLS = [
  "node",
  "npm",
  "pnpm",
  "yarn",
  "dotnet",
  "cargo",
  "rustc",
  "java",
  "mvn",
  "gradle",
] as const;

type ToolName =
  | (typeof REQUIRED_TOOLS)[number]
  | (typeof RECOMMENDED_TOOLS)[number]
  | (typeof TOOLCHAIN_TOOLS)[number];

export type ToolProbe = {
  name: ToolName;
  path: string | null;
  version: string | null;
};

export type PreflightReport = {
  tools: ToolProbe[];
  missingRequired: string[];
  missingRecommended: string[];
  pluginsDir: string | null;
  workspaceWritable: boolean;
  claudeCredentials: ClaudeCredentialSource;
};

export type PreflightDeps = {
  getSearchPath: () => Promise<string>;
  findExecutable: (name: string, searchPath: string) => Promise<string | null>;
  readVersion: (executable: string) => Promise<string | null>;
  getPluginsDir: () => string | null;
  isWritableDirectory: (directory: string) => boolean;
  fileExists: (filePath: string) => boolean;
  env: NodeJS.ProcessEnv;
};

export async function runHeadlessPreflight(
  workspaceDir: string,
  deps: PreflightDeps = defaultPreflightDeps()
): Promise<PreflightReport> {
  const searchPath = await deps.getSearchPath();
  const names: ToolName[] = [
    ...REQUIRED_TOOLS,
    ...RECOMMENDED_TOOLS,
    ...TOOLCHAIN_TOOLS,
  ];
  const tools = await Promise.all(
    names.map(async (name): Promise<ToolProbe> => {
      const executable = await deps.findExecutable(name, searchPath);
      return {
        name,
        path: executable,
        version: executable ? await deps.readVersion(executable) : null,
      };
    })
  );
  const missing = (list: readonly ToolName[]) =>
    tools
      .filter((tool) => list.includes(tool.name) && !tool.path)
      .map((tool) => tool.name);
  return {
    tools,
    missingRequired: missing(REQUIRED_TOOLS),
    missingRecommended: missing(RECOMMENDED_TOOLS),
    pluginsDir: deps.getPluginsDir(),
    workspaceWritable: deps.isWritableDirectory(workspaceDir),
    claudeCredentials: detectClaudeCredentials(deps),
  };
}

/** Problems that make every loop fail; the runner refuses to start on them. */
export function fatalPreflightProblems(report: PreflightReport): string[] {
  const problems: string[] = [];
  if (report.missingRequired.length > 0) {
    problems.push(
      `missing required tools: ${report.missingRequired.join(", ")}`
    );
  }
  if (!report.pluginsDir) {
    problems.push(
      "AgentFlow plugins not found (set AGENTFLOW_PLUGINS_DIR to the agent-plugins directory)"
    );
  }
  if (!report.workspaceWritable) {
    problems.push("the workspace directory is missing or not writable");
  }
  return problems;
}

/** Capabilities reported to AgentFlow when the runner registers. */
export function toCapabilities(
  report: PreflightReport
): ComputeTargetCapabilities {
  const byName = new Map(report.tools.map((tool) => [tool.name, tool]));
  const tools = {} as Record<CapabilityToolName, boolean>;
  const versions: Partial<Record<CapabilityToolName, string>> = {};
  for (const name of ["claude", "codex", "git", "gh", "python3"] as const) {
    const probe = byName.get(name as ToolName);
    tools[name] = Boolean(probe?.path);
    if (probe?.version) {
      versions[name] = probe.version;
    }
  }
  const toolchains: Record<string, string> = {};
  for (const name of TOOLCHAIN_TOOLS) {
    const probe = byName.get(name);
    if (probe?.path) {
      toolchains[name] = probe.version ?? "installed";
    }
  }
  // Unattended runners cannot verify browser-signed commands.
  return { tools, versions, toolchains, commandSigning: false };
}

function detectClaudeCredentials(deps: PreflightDeps): ClaudeCredentialSource {
  return detectClaudeCredentialSource({
    env: deps.env,
    fileExists: deps.fileExists,
  });
}

/**
 * Lookups against this machine. `executables` fixes where a tool is instead of
 * searching PATH for it: on Windows bash, python3 and jq are not found under
 * those names (headless-windows-tools.ts).
 */
export function defaultPreflightDeps(
  executables: Readonly<Record<string, string | null>> = {}
): PreflightDeps {
  return {
    getSearchPath: getShellPath,
    findExecutable: async (name, searchPath) =>
      Object.hasOwn(executables, name)
        ? (executables[name] ?? null)
        : ((await resolveExecutablesOnPath(name, searchPath))[0] ?? null),
    readVersion: readToolVersion,
    getPluginsDir: getBundledPluginsRoot,
    isWritableDirectory,
    fileExists: (filePath) => fs.existsSync(filePath),
    env: process.env,
  };
}

async function readToolVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return FIRST_LINE_RE.exec(stdout.trim())?.[0] ?? null;
  } catch {
    return null;
  }
}

function isWritableDirectory(directory: string): boolean {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
