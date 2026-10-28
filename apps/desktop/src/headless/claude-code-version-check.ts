/**
 * @file claude-code-version-check.ts
 * @description Version check for a personal runner. A personal runner never
 * installs Claude Code. When the model provider pins an exact release, the
 * installed `claude --version` is compared with it before each Claude loop;
 * a mismatch fails the loop with the command the person should run. `latest`
 * is not checked. See docs/runner.md "Claude Code version".
 */

import {
  CLAUDE_CODE_RELEASE_RE,
  ClaudeCodeVersionChannel,
} from "@repo/api/src/types/compute-target-model-provider";
import {
  type ClaudeCodeVersionInstaller,
  ClaudeCodeVersionMismatchError,
} from "../server/operations/claude-code-version-pin.js";
import { type RunResult, runWithoutShell } from "./claude-code-versions.js";

const VERSION_TIMEOUT_MS = 30_000;
const WHITESPACE_RE = /\s+/;

export type ClaudeCodeVersionCheckOptions = {
  /** The person's claude (preflight's path). */
  claudePath: string;
  homeDir: string;
  log: { warn: (message: string) => void };
  /** Runs a binary without a shell; tests replace it. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;
};

export function createClaudeCodeVersionCheck(
  options: ClaudeCodeVersionCheckOptions
): ClaudeCodeVersionInstaller {
  const run =
    options.run ??
    ((file, args, timeoutMs) =>
      runWithoutShell(file, args, timeoutMs, options.homeDir));
  return {
    async ensure(requested) {
      if (
        requested === ClaudeCodeVersionChannel.Latest ||
        !CLAUDE_CODE_RELEASE_RE.test(requested)
      ) {
        return null;
      }
      // Read on every loop: a later `claude install` applies at the next one.
      const result = await run(
        options.claudePath,
        ["--version"],
        VERSION_TIMEOUT_MS
      );
      const installed = result.stdout.trim().split(WHITESPACE_RE)[0] ?? "";
      if (result.code !== 0 || !CLAUDE_CODE_RELEASE_RE.test(installed)) {
        options.log.warn(
          `Could not read this computer's Claude Code version (exit ${result.code}); the loop runs the claude on PATH`
        );
        return null;
      }
      if (installed === requested) {
        return null;
      }
      throw new ClaudeCodeVersionMismatchError(
        `This computer runs Claude Code ${installed}, the provider needs ${requested}: run \`claude install ${requested}\``
      );
    },
  };
}
