/**
 * @file claude-code-versions.ts
 * @description The Claude Code version this runner runs loops with. It is set
 * per computer in AgentFlow (Model provider → Claude Code version, `latest`
 * by default) and sent with every loop. A version that is not on the machine
 * yet is installed with Claude Code's own native installer
 * (`claude install <version>`, which verifies the release checksum) under
 * ~/.local/share/claude/versions. The loop runs that binary by absolute path,
 * and ~/.local/bin/claude is pointed at it, so a plain `claude` on the runner
 * is the same version. `latest` is looked up when each loop starts.
 *
 * The installer is not trusted to switch versions: `claude install latest`
 * leaves ~/.local/bin/claude on the previous version when the latest one is
 * already installed. The version is resolved here, verified with
 * `--version`, and the link is replaced explicitly. See docs/runner.md
 * "Claude Code version".
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_CODE_RELEASE_RE,
  ClaudeCodeVersionChannel,
} from "@repo/api/src/types/compute-target-model-provider";
import { z } from "zod";
import type { ClaudeCodeVersionInstaller } from "../server/operations/claude-code-version-pin.js";

/** Where the official installer looks up releases (claude.ai/install.sh). */
const RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const STATE_FILE = "claude-code-version.json";
const LOOKUP_TIMEOUT_MS = 15_000;
const LOOKUP_RETRY_DELAY_MS = 1000;
const VERSION_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const WHITESPACE_RE = /\s+/;

export type EnsuredClaudeCode = { version: string; binaryPath: string };

export type RunResult = { code: number; stdout: string; stderr: string };

export type ClaudeCodeVersionsOptions = {
  homeDir: string;
  /** Runner data directory: keeps the version last set across restarts. */
  dataDir: string;
  /** A `claude` binary that can run `claude install`, e.g. the image's own. */
  installerPath: string;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** The latest release number; tests replace the network lookup. */
  lookupLatest?: () => Promise<string>;
  /** Runs a binary without a shell; tests replace it. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;
};

export type ClaudeCodeVersions = ClaudeCodeVersionInstaller & {
  /** Points `claude` back at the version last set (after a restart). */
  restore(): Promise<EnsuredClaudeCode | null>;
};

const stateSchema = z.object({
  requested: z.string(),
  version: z.string().regex(CLAUDE_CODE_RELEASE_RE),
  binaryPath: z.string().min(1),
});

export function createClaudeCodeVersions(
  options: ClaudeCodeVersionsOptions
): ClaudeCodeVersions {
  const versionsDir = path.join(
    options.homeDir,
    ".local",
    "share",
    "claude",
    "versions"
  );
  const linkPath = path.join(options.homeDir, ".local", "bin", "claude");
  const statePath = path.join(options.dataDir, STATE_FILE);
  const lookupLatest = options.lookupLatest ?? fetchLatestRelease;
  const run =
    options.run ??
    ((file: string, args: string[], timeoutMs: number) =>
      runWithoutShell(file, args, timeoutMs, options.homeDir));
  const { log } = options;
  // One version change at a time, in the order loops asked: the last request
  // is the one `claude` ends up pointing at.
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  const reportsVersion = async (binaryPath: string, version: string) => {
    if (!(await isExecutable(binaryPath))) {
      return false;
    }
    const result = await run(binaryPath, ["--version"], VERSION_TIMEOUT_MS);
    return (
      result.code === 0 &&
      result.stdout.trim().split(WHITESPACE_RE)[0] === version
    );
  };

  const bundledBinary = () => realpath(options.installerPath).catch(() => null);

  /** The newest release on this machine: the installed ones and the image's. */
  const newestAvailable = async (): Promise<string | null> => {
    const entries = await readdir(versionsDir).catch(() => [] as string[]);
    const bundled = await bundledBinary();
    if (bundled) {
      const result = await run(bundled, ["--version"], VERSION_TIMEOUT_MS);
      entries.push(result.stdout.trim().split(WHITESPACE_RE)[0] ?? "");
    }
    const releases = entries
      .filter((entry) => CLAUDE_CODE_RELEASE_RE.test(entry))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return releases.at(-1) ?? null;
  };

  const lookupLatestRelease = async (): Promise<string> => {
    const answer = (
      await lookupLatest().catch(async () => {
        await delay(LOOKUP_RETRY_DELAY_MS);
        return lookupLatest();
      })
    ).trim();
    if (!CLAUDE_CODE_RELEASE_RE.test(answer)) {
      throw new Error(`unexpected answer "${answer.slice(0, 40)}"`);
    }
    return answer;
  };

  const resolveVersion = async (requested: string): Promise<string | null> => {
    if (requested !== ClaudeCodeVersionChannel.Latest) {
      return requested;
    }
    try {
      return await lookupLatestRelease();
    } catch (error) {
      const fallback = await newestAvailable();
      const using = fallback
        ? `using ${fallback}, the newest on this runner`
        : "using the default claude";
      log.warn(
        `Could not look up the latest Claude Code release (${errorMessage(error)}); ${using}`
      );
      return fallback;
    }
  };

  /** An installed copy of the version: the managed one or the image's own. */
  const findInstalled = async (version: string): Promise<string | null> => {
    const managed = path.join(versionsDir, version);
    if (await reportsVersion(managed, version)) {
      return managed;
    }
    const bundled = await bundledBinary();
    if (bundled && (await reportsVersion(bundled, version))) {
      return bundled;
    }
    return null;
  };

  const install = async (version: string): Promise<string> => {
    const managed = path.join(versionsDir, version);
    // A copy that fails `--version` is reinstalled rather than kept.
    const force = await isExecutable(managed);
    log.info(`Installing Claude Code ${version}`);
    const result = await run(
      options.installerPath,
      ["install", version, ...(force ? ["--force"] : [])],
      INSTALL_TIMEOUT_MS
    );
    if (!(await reportsVersion(managed, version))) {
      const detail = lastLine(`${result.stdout}\n${result.stderr}`);
      throw new Error(
        `claude install ${version} failed (exit ${result.code}): ${detail || "no output"}`
      );
    }
    log.info(`Installed Claude Code ${version}`);
    return managed;
  };

  const activate = async (binaryPath: string) => {
    await mkdir(path.dirname(linkPath), { recursive: true });
    const temporary = `${linkPath}.${process.pid}.${Date.now()}`;
    await symlink(binaryPath, temporary);
    await rename(temporary, linkPath);
  };

  return {
    ensure: (requested) =>
      serialize(async () => {
        const version = await resolveVersion(requested);
        if (!version) {
          return null;
        }
        const binaryPath =
          (await findInstalled(version)) ?? (await install(version));
        // The loop runs binaryPath directly: a plain `claude` that cannot be
        // moved is reported, not fatal.
        try {
          await activate(binaryPath);
          await writeState(statePath, { requested, version, binaryPath });
        } catch (error) {
          log.warn(
            `Could not point ${linkPath} at Claude Code ${version}: ${errorMessage(error)}`
          );
        }
        return { version, binaryPath };
      }),
    restore: () =>
      serialize(async () => {
        const state = await readState(statePath);
        if (!(state && (await isExecutable(state.binaryPath)))) {
          return null;
        }
        await activate(state.binaryPath);
        return { version: state.version, binaryPath: state.binaryPath };
      }),
  };
}

async function fetchLatestRelease(): Promise<string> {
  const response = await fetch(
    `${RELEASES_URL}/${ClaudeCodeVersionChannel.Latest}`,
    { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

export function runWithoutShell(
  file: string,
  args: string[],
  timeoutMs: number,
  homeDir: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      // The installer works under HOME. DISABLE_AUTOUPDATER (the image sets
      // it too): a native install must never update itself away from the
      // version set in AgentFlow.
      {
        env: { ...process.env, HOME: homeDir, DISABLE_AUTOUPDATER: "1" },
        timeout: timeoutMs,
        maxBuffer: OUTPUT_MAX_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        // No numeric exit code: the binary could not start or timed out.
        const { code } = error;
        resolve(
          typeof code === "number"
            ? { code, stdout: String(stdout), stderr: String(stderr) }
            : {
                code: 1,
                stdout: String(stdout),
                stderr: `${stderr}\n${error.message}`,
              }
        );
      }
    );
  });
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readState(
  statePath: string
): Promise<z.infer<typeof stateSchema> | null> {
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(await readFile(statePath, "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeState(
  statePath: string,
  state: z.infer<typeof stateSchema>
): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
