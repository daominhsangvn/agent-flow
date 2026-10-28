/**
 * @file platform-shell.ts
 * @description What loops need from the operating system to run their bash
 * scripts and stop their process trees.
 *
 * macOS and Linux use the system `bash` and process groups (children are
 * spawned `detached`, so `kill(-pid)` reaches every descendant). Windows has
 * neither: scripts run under Git for Windows' bash (never `System32\bash.exe`,
 * which is WSL and sees another filesystem), and a tree is stopped with
 * `taskkill /T /F`. See docs/runner.md "Option D: Windows".
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Explicit Git Bash location (`...\Git\bin\bash.exe`); wins over discovery. */
export const GIT_BASH_PATH_ENV = "AGENTFLOW_GIT_BASH_PATH";
/** Claude Code's own setting for the bash it runs tools in on Windows. */
export const CLAUDE_CODE_GIT_BASH_PATH_ENV = "CLAUDE_CODE_GIT_BASH_PATH";
/**
 * Directory of the runner's Windows shims (`python3`, `jq`,
 * `python/sitecustomize.py`), prepended to the PATH of loop processes. Set by
 * the headless runner at startup (headless-windows-tools.ts).
 */
export const WINDOWS_SHIMS_DIR_ENV = "AGENTFLOW_WINDOWS_SHIMS_DIR";

const WINDOWS_PLATFORM = "win32";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const TASKKILL_TIMEOUT_MS = 10_000;
/** Ancestors of `git.exe` searched for `bin\bash.exe` (`cmd\`, `mingw64\bin\`). */
const GIT_ROOT_SEARCH_DEPTH = 3;
const SHELL_PATH_ENV_PREFIX = "AGENTFLOW_";
const SHELL_PATH_ENV_KEYS: ReadonlySet<string> = new Set(["CLAUDE_BIN"]);

export function isWindows(platform: NodeJS.Platform = process.platform) {
  return platform === WINDOWS_PLATFORM;
}

/**
 * A path as bash scripts should see it. On Windows `C:\work\repo` becomes
 * `C:/work/repo`, which Git Bash, git and native Windows programs all accept
 * and which survives `dirname`, `${dir%/*}` and string comparisons with
 * `git rev-parse` output. Unchanged elsewhere.
 */
export function toShellPath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  return isWindows(platform) ? value.replaceAll("\\", "/") : value;
}

/**
 * The file names `name` can have on disk as an executable: on Windows each
 * PATHEXT extension (`git` → `git.exe`, `npm` → `npm.cmd`), or `name` itself
 * when it already carries one; elsewhere `name`.
 */
export function executableFileNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (!isWindows(platform)) {
    return [name];
  }
  const extensions = (readEnv(env, "PATHEXT") || DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const current = path.win32.extname(name).toLowerCase();
  if (current && extensions.includes(current)) {
    return [name];
  }
  return extensions.map((extension) => `${name}${extension}`);
}

/** Reads an environment variable the way Windows does: case-insensitively. */
export function readEnv(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  if (env[name] !== undefined) {
    return env[name];
  }
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/**
 * Sets `name` in a copied environment, dropping keys that differ only in case.
 * A child process given both `Path` and `PATH` on Windows sees one of them,
 * chosen by sort order, not the one just set.
 */
export function setEnvValue(
  env: Record<string, string | undefined>,
  name: string,
  value: string
): void {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key !== name && key.toUpperCase() === upper) {
      delete env[key];
    }
  }
  env[name] = value;
}

export type GitBashLookup = {
  env: NodeJS.ProcessEnv;
  isFile: (file: string) => boolean;
};

/**
 * Git for Windows' `bin\bash.exe`: the configured path, else next to the
 * `git.exe` on PATH, else the default install locations. Null when none
 * exists. `bin\bash.exe` (not `usr\bin\bash.exe`) puts Git's `usr\bin` and
 * `mingw64\bin` (grep, tee, curl, ...) on the script's PATH.
 */
export function findGitBash(lookup: GitBashLookup): string | null {
  const { env, isFile } = lookup;
  for (const name of [GIT_BASH_PATH_ENV, CLAUDE_CODE_GIT_BASH_PATH_ENV]) {
    const configured = readEnv(env, name)?.trim();
    if (configured && isFile(configured)) {
      return configured;
    }
  }
  const candidates: string[] = [];
  const git = findGitOnPath(env, isFile);
  if (git) {
    let dir = path.win32.dirname(git);
    for (let depth = 0; depth < GIT_ROOT_SEARCH_DEPTH; depth++) {
      dir = path.win32.dirname(dir);
      candidates.push(path.win32.join(dir, "bin", "bash.exe"));
    }
  }
  for (const root of [
    readEnv(env, "ProgramW6432"),
    readEnv(env, "ProgramFiles"),
    readEnv(env, "LOCALAPPDATA") &&
      path.win32.join(readEnv(env, "LOCALAPPDATA") ?? "", "Programs"),
  ]) {
    if (root) {
      candidates.push(path.win32.join(root, "Git", "bin", "bash.exe"));
    }
  }
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

let cachedGitBash: string | null | undefined;

/** findGitBash for this machine, cached. */
export function getGitBashPath(): string | null {
  if (cachedGitBash === undefined) {
    cachedGitBash = findGitBash({ env: process.env, isFile: isExistingFile });
  }
  return cachedGitBash;
}

/** Test-only: forget the cached Git Bash location. */
export function resetGitBashPathForTests(): void {
  cachedGitBash = undefined;
}

/**
 * The bash that runs loop scripts: `bash` on PATH, or Git Bash on Windows.
 * Throws on Windows without Git for Windows rather than falling back to a
 * `bash` on PATH, which there is usually WSL's.
 */
export function bashCommand(
  platform: NodeJS.Platform = process.platform
): string {
  if (!isWindows(platform)) {
    return "bash";
  }
  const gitBash = getGitBashPath();
  if (!gitBash) {
    throw new Error(
      `Git for Windows (bash.exe) not found: install it or set ${GIT_BASH_PATH_ENV}`
    );
  }
  return gitBash;
}

/**
 * How to start a bash script with arguments. Scripts are executable and run
 * directly through their shebang, except on Windows, which runs them with Git
 * Bash and needs the script path in bash form.
 */
export function scriptLaunch(
  scriptPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (!isWindows(platform)) {
    return { command: scriptPath, args };
  }
  return {
    command: bashCommand(platform),
    args: [toShellPath(scriptPath, platform), ...args],
  };
}

/**
 * Environment additions for loop processes on Windows (none elsewhere):
 *   - Claude Code uses the same Git Bash as the scripts.
 *   - Python reads and writes UTF-8, and the shims' sitecustomize.py makes it
 *     print `\n`, not `\r\n`, so `$(python3 ...)` in bash carries no `\r`.
 *   - The shims directory comes first on PATH (`python3`, `jq`).
 *   - AgentFlow's own path variables use forward slashes (toShellPath).
 */
export function applyWindowsLoopEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (!isWindows(platform)) {
    return env;
  }
  const result = { ...env };
  const gitBash = getGitBashPath();
  if (gitBash && !readEnv(result, CLAUDE_CODE_GIT_BASH_PATH_ENV)) {
    result[CLAUDE_CODE_GIT_BASH_PATH_ENV] = gitBash;
  }
  result.PYTHONUTF8 ??= "1";
  result.PYTHONIOENCODING ??= "utf-8";
  const shimsDir = readEnv(result, WINDOWS_SHIMS_DIR_ENV);
  if (shimsDir) {
    const pythonPath = readEnv(result, "PYTHONPATH");
    setEnvValue(
      result,
      "PYTHONPATH",
      [path.win32.join(shimsDir, "python"), pythonPath]
        .filter(Boolean)
        .join(";")
    );
  }
  for (const [key, value] of Object.entries(result)) {
    if (isShellPathEnvKey(key) && WINDOWS_ABSOLUTE_PATH_RE.test(value)) {
      result[key] = toShellPath(value, platform);
    }
  }
  return result;
}

/**
 * Signals a process and everything it started. POSIX signals the process
 * group (the child was spawned `detached`, so it leads one). Windows has no
 * graceful equivalent for console programs: both signals end the tree with
 * `taskkill /T /F`. Throws `ESRCH` when there is no such process, like
 * `process.kill`.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): void {
  if (!isWindows(platform)) {
    process.kill(-pid, signal);
    return;
  }
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const error: NodeJS.ErrnoException = new Error(
      `taskkill could not stop process ${pid} (exit ${String(result.status)})`
    );
    error.code = "ESRCH";
    throw error;
  }
}

function isShellPathEnvKey(key: string): boolean {
  return key.startsWith(SHELL_PATH_ENV_PREFIX) || SHELL_PATH_ENV_KEYS.has(key);
}

function findGitOnPath(
  env: NodeJS.ProcessEnv,
  isFile: (file: string) => boolean
): string | null {
  const searchPath = readEnv(env, "PATH") ?? "";
  for (const dir of searchPath.split(";")) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    for (const name of executableFileNames("git", WINDOWS_PLATFORM, env)) {
      const candidate = path.win32.join(trimmed, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExistingFile(file: string): boolean {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
