/**
 * @file headless-windows-tools.ts
 * @description Makes a Windows machine look like what run-loop.sh and the
 * plugins expect from bash (docs/runner.md "Option D: Windows").
 *
 * Python and jq for Windows are installed as `python.exe` / `py.exe` and
 * `jq.exe`, and both write `\r\n` line endings, so every `$(python3 ...)` or
 * `$(jq -r ...)` value in a script would carry a trailing `\r`. The runner
 * writes a shims directory, prepended to the PATH of loop processes:
 *
 *   shims/python3                   runs the Python found on this machine
 *   shims/jq                        runs jq.exe with `--binary` (LF output)
 *   shims/python/sitecustomize.py   on PYTHONPATH: Python prints `\n`
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  findGitBash,
  toShellPath,
  WINDOWS_SHIMS_DIR_ENV,
} from "../server/platform-shell.js";
import { resolveExecutablesOnPath } from "../server/shell-path.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;
const SHIMS_DIR_NAME = "shims";
const SHIM_MODE = 0o755;
const FIRST_LINE_RE = /^[^\r\n]*/;

/** Commands tried, in order, to find a working Python 3. */
const PYTHON_CANDIDATES: readonly (readonly string[])[] = [
  ["python3"],
  ["python"],
  ["py", "-3"],
];

const SITECUSTOMIZE = `# Written by the AgentFlow runner (Windows). Bash reads what Python prints,
# and a "\\r" before each newline would end up in every $(python3 ...) value.
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(newline="\\n")
    except (AttributeError, ValueError):
        pass
`;

/** What the runner found; null entries are reported missing by preflight. */
export type WindowsTools = {
  shimsDir: string;
  gitBash: string | null;
  python: string | null;
  jq: string | null;
};

export type WindowsToolsDeps = {
  env: NodeJS.ProcessEnv;
  /** sys.executable of a Python 3 run as `command args`, or null. */
  probePython: (
    command: string,
    args: readonly string[]
  ) => Promise<string | null>;
  findOnPath: (name: string) => Promise<string | null>;
  isFile: (file: string) => boolean;
  writeFile: (file: string, content: string) => void;
};

/**
 * Finds Git Bash, Python and jq, writes the shims for the ones found, and
 * points WINDOWS_SHIMS_DIR_ENV at them in `deps.env`. Call before the first
 * getShellPath(), which puts that directory first on PATH.
 */
export async function prepareWindowsTools(
  dataDir: string,
  deps: WindowsToolsDeps = defaultWindowsToolsDeps()
): Promise<WindowsTools> {
  const shimsDir = path.join(dataDir, SHIMS_DIR_NAME);
  const python = await findPython(deps);
  const jq = await deps.findOnPath("jq");
  if (python) {
    deps.writeFile(path.join(shimsDir, "python3"), execShim(python, []));
    deps.writeFile(
      path.join(shimsDir, "python", "sitecustomize.py"),
      SITECUSTOMIZE
    );
  }
  if (jq) {
    deps.writeFile(path.join(shimsDir, "jq"), execShim(jq, ["--binary"]));
  }
  deps.env[WINDOWS_SHIMS_DIR_ENV] = shimsDir;
  return {
    shimsDir,
    gitBash: findGitBash({ env: deps.env, isFile: deps.isFile }),
    python,
    jq,
  };
}

/** Preflight lookups for the tools bash scripts call by their POSIX names. */
export function windowsToolOverrides(
  tools: WindowsTools
): Record<string, string | null> {
  return { bash: tools.gitBash, python3: tools.python, jq: tools.jq };
}

async function findPython(deps: WindowsToolsDeps): Promise<string | null> {
  for (const [command, ...args] of PYTHON_CANDIDATES) {
    const executable = await deps.probePython(command, args);
    if (executable) {
      return executable;
    }
  }
  return null;
}

/** A bash script that replaces itself with `target` (LF line endings). */
function execShim(target: string, args: string[]): string {
  // Shims exist on Windows only, where bash takes `C:/...` paths.
  const quoted = [toShellPath(target, "win32"), ...args]
    .map((part) => `'${part.replaceAll("'", String.raw`'\''`)}'`)
    .join(" ");
  return `#!/usr/bin/env bash\nexec ${quoted} "$@"\n`;
}

function defaultWindowsToolsDeps(): WindowsToolsDeps {
  return {
    env: process.env,
    probePython: probePythonExecutable,
    findOnPath: async (name) =>
      (await resolveExecutablesOnPath(name, process.env.PATH ?? ""))[0] ?? null,
    isFile: (file) => fs.existsSync(file),
    writeFile: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: SHIM_MODE });
    },
  };
}

/**
 * Runs the candidate and asks it for its own path. The Microsoft Store
 * aliases (`python.exe` / `python3.exe` in WindowsApps) exist even when no
 * Python is installed and fail here, so they are never picked.
 */
async function probePythonExecutable(
  command: string,
  args: readonly string[]
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      command,
      [
        ...args,
        "-c",
        "import sys; assert sys.version_info >= (3,); print(sys.executable)",
      ],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    );
    return FIRST_LINE_RE.exec(stdout.trim())?.[0] || null;
  } catch {
    return null;
  }
}
