import { existsSync } from "node:fs";
import path from "node:path";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import { bashCommand, toShellPath } from "../platform-shell.js";
import { getBundledPluginDir } from "./bundled-plugins.js";
import {
  CommandPackLaunchMode,
  type RuntimeSelection,
} from "./command-pack-factory.js";
import { findPluginVersions, getPluginCacheRoot } from "./plugin-cache.js";

/**
 * Shell pipelines that run a loop's harness CLI (Claude Code or Codex) with
 * stream-json output, tee it to claude-output.jsonl and format it for the log.
 */

/** Single-quotes a value for bash. */
export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Single-quotes a file path for bash, in the form bash uses (toShellPath). */
function shellEscapePath(value: string): string {
  return shellEscape(toShellPath(value));
}

/**
 * Find the stream_formatter.py script from the code plugin.
 * Reuses getPluginCacheRoot() and findPluginVersions() from plugin-cache.ts.
 * Falls back to null if not installed — caller should degrade gracefully.
 */
function findStreamFormatter(): string | null {
  // Unit/integration tests set this to exercise the raw `claude` bash wrapper
  // without grep/tee/python (stub claude output is not a full formatter stream).
  if (process.env.AGENTFLOW_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE === "1") {
    return null;
  }
  const bundledCodeDir = getBundledPluginDir("code");
  if (bundledCodeDir) {
    const bundled = path.join(
      bundledCodeDir,
      "tools",
      "python",
      "stream_formatter.py"
    );
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  const pluginDir = path.join(getPluginCacheRoot(), "code");
  const versions = findPluginVersions(pluginDir);
  for (const v of versions) {
    const p = path.join(pluginDir, v, "tools", "python", "stream_formatter.py");
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Build a bash pipeline command that runs claude with stream-json output,
 * filters JSON lines, tees to a jsonl log, and formats for human reading.
 * Falls back to raw claude if formatter is not available.
 */
export function buildClaudePipeline(
  claudeArgs: string[],
  claudeWorkDir: string,
  claudeBinary: string,
  stdinFile?: string
): { cmd: string; args: string[] } {
  const formatter = findStreamFormatter();
  const stderrFile = path.join(claudeWorkDir, "claude-stderr.log");
  const jsonlFile = path.join(claudeWorkDir, "claude-output.jsonl");

  // Build the claude command with properly escaped args
  const escapedArgs = claudeArgs.map(shellEscape).join(" ");
  const escapedBinary = shellEscapePath(claudeBinary);
  const claudeCmd = stdinFile
    ? `${escapedBinary} ${escapedArgs} < ${shellEscapePath(stdinFile)}`
    : `${escapedBinary} ${escapedArgs}`;

  if (formatter) {
    // Full pipeline matching run-loop.sh:
    // claude ... 2>stderr | grep JSON | tee jsonl | formatter
    const pipeline = [
      `${claudeCmd} 2>${shellEscapePath(stderrFile)}`,
      "grep --line-buffered '^{'",
      `tee -a ${shellEscapePath(jsonlFile)}`,
      `python3 ${shellEscapePath(formatter)}`,
    ].join(" | ");
    return {
      cmd: bashCommand(),
      args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`],
    };
  }

  // No formatter — wrap in bash pipeline so grep|tee still writes claude-output.jsonl
  const pipeline = [
    `${claudeCmd} 2>${shellEscapePath(stderrFile)}`,
    "grep --line-buffered '^{'",
    `tee -a ${shellEscapePath(jsonlFile)}`,
  ].join(" | ");
  return {
    cmd: bashCommand(),
    args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`],
  };
}

export type SupportedRuntimeSelection = Extract<RuntimeSelection, { ok: true }>;

function buildCodexPromptPipeline(
  codexBinary: string,
  promptFile: string,
  claudeWorkDir: string
): { cmd: string; args: string[] } {
  const stderrFile = path.join(claudeWorkDir, "claude-stderr.log");
  const jsonlFile = path.join(claudeWorkDir, "claude-output.jsonl");
  const codexCmd = [
    shellEscapePath(codexBinary),
    "exec",
    "--full-auto",
    "--json",
    "-",
    "<",
    shellEscapePath(promptFile),
  ].join(" ");
  // Tee the Codex `--json` event stream to claude-output.jsonl (mirrors the
  // Claude pipeline) so the output tailer + native observability adapter can
  // read it. `grep '^{'` keeps only JSON event lines; PIPESTATUS[0] preserves
  // Codex's exit code through the pipeline.
  const pipeline = [
    `${codexCmd} 2>${shellEscapePath(stderrFile)}`,
    "grep --line-buffered '^{'",
    `tee -a ${shellEscapePath(jsonlFile)}`,
  ].join(" | ");
  return {
    cmd: bashCommand(),
    args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`],
  };
}

export function buildNativePromptPipeline(
  runtime: SupportedRuntimeSelection,
  claudeArgs: string[],
  claudeWorkDir: string,
  harnessBinary: string,
  promptFile: string
): { cmd: string; args: string[] } {
  if (runtime.harness.adapter.harness === LoopHarness.Codex) {
    return buildCodexPromptPipeline(harnessBinary, promptFile, claudeWorkDir);
  }
  return buildClaudePipeline(
    claudeArgs,
    claudeWorkDir,
    harnessBinary,
    promptFile
  );
}

export function harnessUsesNativePrompt(
  runtime: SupportedRuntimeSelection
): boolean {
  return runtime.harness.launchMode === CommandPackLaunchMode.NativePrompt;
}
