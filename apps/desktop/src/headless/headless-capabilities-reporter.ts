/**
 * @file headless-capabilities-reporter.ts
 * @description Uploads a personal runner's `AGENTFLOW.md` (docs/runner.md
 * "Capabilities (AGENTFLOW.md)"): the commands and skills its owner declares
 * in the project folder, so the project's orchestrator knows what this runner
 * can do. The file is read when the runner connects and again whenever it
 * changes; the runner adds the warnings only it can see (a declared command
 * that is not in `.claude/commands` or `.claude/skills`), and the API parses
 * the front matter itself.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNNER_CAPABILITIES_FILE_NAME,
  RUNNER_CAPABILITIES_MAX_CHARS,
  RunnerCapabilitiesSource,
} from "@repo/api/src/types/runner-capabilities";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import { collectCapabilityWarningsIn } from "../server/operations/capability-warnings.js";

const LOG_TAG = "headless-capabilities";
const TRAILING_SLASHES_RE = /\/+$/;
/** Editors write a file in several steps: upload once it settles. */
export const CAPABILITIES_WATCH_DEBOUNCE_MS = 1000;

type Watcher = { close(): void };

export type CapabilitiesReporterDeps = {
  apiUrl: string;
  apiKey: string;
  /** The AgentFlow project key of the personal runner, e.g. PRO-1. */
  projectKey: string;
  projectDir: string;
  /** The account's home, whose `~/.claude` also holds commands and skills. */
  homeDir?: string;
  getComputeTargetId: () => string | null;
  fetchImpl?: typeof fetch;
  watch?: (dir: string, onChange: (fileName: string | null) => void) => Watcher;
  debounceMs?: number;
};

export type HeadlessCapabilitiesReporter = {
  /** Uploads the file now (the runner just connected, or the file changed). */
  report(options?: { force?: boolean }): Promise<void>;
  stop(): void;
};

export function startHeadlessCapabilitiesReporter(
  deps: CapabilitiesReporterDeps
): HeadlessCapabilitiesReporter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const homeDir = deps.homeDir ?? os.homedir();
  const filePath = path.join(deps.projectDir, RUNNER_CAPABILITIES_FILE_NAME);
  let uploadedHash: string | null = null;
  let missingLogged = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const report = async (options: { force?: boolean } = {}) => {
    const computeTargetId = deps.getComputeTargetId();
    if (stopped || !computeTargetId) {
      return;
    }
    const content = readCapabilitiesFile(filePath);
    if (content === null) {
      if (!missingLogged) {
        gatewayLog.info(
          LOG_TAG,
          `No ${RUNNER_CAPABILITIES_FILE_NAME} in ${deps.projectDir}: the orchestrator will not know this runner's commands`
        );
        missingLogged = true;
      }
      return;
    }
    missingLogged = false;
    const hash = createHash("sha256").update(content).digest("hex");
    if (!options.force && hash === uploadedHash) {
      return;
    }
    const warnings = collectCapabilityWarnings(content, [
      deps.projectDir,
      homeDir,
    ]);
    for (const warning of warnings) {
      gatewayLog.warn(LOG_TAG, `${RUNNER_CAPABILITIES_FILE_NAME}: ${warning}`);
    }
    const url = `${deps.apiUrl.replace(TRAILING_SLASHES_RE, "")}/compute-targets/${encodeURIComponent(computeTargetId)}/capabilities`;
    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project: deps.projectKey,
          source: RunnerCapabilitiesSource.Personal,
          content,
          warnings,
        }),
      });
      if (response.ok) {
        uploadedHash = hash;
        gatewayLog.info(
          LOG_TAG,
          `Uploaded ${RUNNER_CAPABILITIES_FILE_NAME} for ${deps.projectKey}`
        );
        return;
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      gatewayLog.warn(
        LOG_TAG,
        `Uploading ${RUNNER_CAPABILITIES_FILE_NAME} answered ${response.status}: ${detail}`
      );
    } catch (error) {
      gatewayLog.warn(
        LOG_TAG,
        `Uploading ${RUNNER_CAPABILITIES_FILE_NAME} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const watch = deps.watch ?? watchDirectory;
  let watcher: Watcher | null = null;
  try {
    watcher = watch(deps.projectDir, (fileName) => {
      if (fileName !== null && fileName !== RUNNER_CAPABILITIES_FILE_NAME) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        report().catch(() => undefined);
      }, deps.debounceMs ?? CAPABILITIES_WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
  } catch (error) {
    gatewayLog.warn(
      LOG_TAG,
      `Cannot watch ${deps.projectDir} for ${RUNNER_CAPABILITIES_FILE_NAME} changes: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    report,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      watcher?.close();
    },
  };
}

/**
 * What only the runner can check: each declared command or skill exists in
 * `.claude/commands` or `.claude/skills` of one of the given folders (the
 * project folder, then the account's home). A plugin's command cannot be
 * checked this way, so the warning says so instead of calling it missing.
 */
export function collectCapabilityWarnings(
  content: string,
  roots: string[]
): string[] {
  return collectCapabilityWarningsIn(
    content,
    (rel) =>
      roots.some((root) => fs.existsSync(path.join(root, ...rel.split("/")))),
    "the project folder or ~/.claude"
  );
}

function readCapabilitiesFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(0, RUNNER_CAPABILITIES_MAX_CHARS);
  } catch {
    return null;
  }
}

function watchDirectory(
  dir: string,
  onChange: (fileName: string | null) => void
): Watcher {
  const watcher = fs.watch(dir, { persistent: false }, (_event, fileName) =>
    onChange(fileName === null ? null : String(fileName))
  );
  watcher.on("error", (error) =>
    gatewayLog.warn(LOG_TAG, `Watching ${dir} failed: ${error.message}`)
  );
  return watcher;
}
