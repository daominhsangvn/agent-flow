/**
 * @file claude-code-version-pin.ts
 * @description Which harness binary a loop runs. On a headless runner a
 * Claude loop carries the Claude Code version set for the computer in
 * AgentFlow (Model provider → Claude Code version); the runner's installer
 * makes sure that version is installed and returns its binary. Without an
 * installer (the desktop app) the binary resolves as before: the configured
 * override, then the login-shell PATH.
 */

import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  type BinaryName,
  type BinaryResolveResult,
  resolveBinaryFromLoginShell,
} from "../shell-path.js";

/** Installs a Claude Code version on this machine and returns its binary. */
export type ClaudeCodeVersionInstaller = {
  /** Null when the version cannot be pinned and the default `claude` runs. */
  ensure(
    requested: string
  ): Promise<{ version: string; binaryPath: string } | null>;
};

export type LoopHarnessBinary = {
  resolved: BinaryResolveResult;
  /** Why the loop cannot start, or null. */
  error: string | null;
};

let installer: ClaudeCodeVersionInstaller | null = null;

/** Set once by the headless runner; the desktop app never sets it. */
export function configureClaudeCodeVersionInstaller(
  next: ClaudeCodeVersionInstaller | null
): void {
  installer = next;
}

export async function resolveLoopHarnessBinary(args: {
  adapter: { harness: LoopHarness; binaryName: BinaryName };
  claudeCodeVersion?: string;
  override?: string;
}): Promise<LoopHarnessBinary> {
  const { adapter, claudeCodeVersion } = args;
  let override = args.override;
  if (
    installer &&
    claudeCodeVersion &&
    adapter.harness === LoopHarness.Claude
  ) {
    try {
      const ensured = await installer.ensure(claudeCodeVersion);
      override = ensured?.binaryPath ?? override;
    } catch (error) {
      return {
        resolved: { path: adapter.binaryName, source: "fallback" },
        error: `Claude Code ${claudeCodeVersion} is not available on this runner: ${errorMessage(error)}`,
      };
    }
  }
  const resolved = await resolveBinaryFromLoginShell(
    adapter.binaryName,
    override
  );
  return {
    resolved,
    error:
      resolved.source === "fallback"
        ? `${adapter.binaryName} CLI not found in PATH`
        : null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
