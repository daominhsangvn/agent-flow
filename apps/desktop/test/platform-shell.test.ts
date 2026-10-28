import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  applyWindowsLoopEnv,
  CLAUDE_CODE_GIT_BASH_PATH_ENV,
  executableFileNames,
  findGitBash,
  GIT_BASH_PATH_ENV,
  killProcessTree,
  readEnv,
  resetGitBashPathForTests,
  scriptLaunch,
  setEnvValue,
  toShellPath,
  WINDOWS_SHIMS_DIR_ENV,
} from "../src/server/platform-shell.js";

const GIT_BASH = String.raw`C:\Program Files\Git\bin\bash.exe`;

afterEach(() => {
  delete process.env[GIT_BASH_PATH_ENV];
  resetGitBashPathForTests();
});

test("toShellPath turns Windows separators into slashes on Windows only", () => {
  assert.equal(
    toShellPath(String.raw`C:\work\repo\run-loop.sh`, "win32"),
    "C:/work/repo/run-loop.sh"
  );
  assert.equal(toShellPath(String.raw`a\b`, "linux"), String.raw`a\b`);
  assert.equal(toShellPath("/srv/work", "darwin"), "/srv/work");
});

test("executableFileNames adds PATHEXT extensions on Windows", () => {
  const env = { PATHEXT: ".COM;.EXE;.CMD" };
  assert.deepEqual(executableFileNames("git", "win32", env), [
    "git.com",
    "git.exe",
    "git.cmd",
  ]);
  assert.deepEqual(executableFileNames("npm.cmd", "win32", env), ["npm.cmd"]);
  assert.deepEqual(executableFileNames("git", "linux", env), ["git"]);
});

test("executableFileNames falls back to the default PATHEXT", () => {
  assert.deepEqual(executableFileNames("jq", "win32", {}), [
    "jq.com",
    "jq.exe",
    "jq.bat",
    "jq.cmd",
  ]);
});

test("readEnv and setEnvValue treat names case-insensitively", () => {
  const env: Record<string, string | undefined> = { Path: String.raw`C:\bin` };
  assert.equal(readEnv(env, "PATH"), String.raw`C:\bin`);
  setEnvValue(env, "PATH", String.raw`C:\shims;C:\bin`);
  assert.deepEqual(env, { PATH: String.raw`C:\shims;C:\bin` });
});

test("findGitBash prefers the configured path", () => {
  const configured = String.raw`D:\Tools\Git\bin\bash.exe`;
  const found = findGitBash({
    env: { [GIT_BASH_PATH_ENV]: configured, PATH: "" },
    isFile: (file) => file === configured || file === GIT_BASH,
  });
  assert.equal(found, configured);
});

test("findGitBash ignores a configured path that does not exist", () => {
  const found = findGitBash({
    env: {
      [CLAUDE_CODE_GIT_BASH_PATH_ENV]: String.raw`D:\missing\bash.exe`,
      ProgramFiles: String.raw`C:\Program Files`,
    },
    isFile: (file) => file === GIT_BASH,
  });
  assert.equal(found, GIT_BASH);
});

test("findGitBash finds bin\\bash.exe next to the git.exe on PATH", () => {
  const gitExe = String.raw`E:\PortableGit\cmd\git.exe`;
  const bash = String.raw`E:\PortableGit\bin\bash.exe`;
  const found = findGitBash({
    env: {
      Path: String.raw`C:\Windows\System32;E:\PortableGit\cmd`,
      PATHEXT: ".EXE",
    },
    isFile: (file) => file === gitExe || file === bash,
  });
  assert.equal(found, bash);
});

test("findGitBash never picks WSL's System32 bash", () => {
  const found = findGitBash({
    env: { PATH: String.raw`C:\Windows\System32`, PATHEXT: ".EXE" },
    isFile: (file) => file === String.raw`C:\Windows\System32\bash.exe`,
  });
  assert.equal(found, null);
});

test("scriptLaunch runs scripts directly outside Windows", () => {
  assert.deepEqual(scriptLaunch("/plugins/run-loop.sh", ["/w"], "linux"), {
    command: "/plugins/run-loop.sh",
    args: ["/w"],
  });
});

test("scriptLaunch runs scripts with Git Bash on Windows", () => {
  process.env[GIT_BASH_PATH_ENV] = process.execPath;
  resetGitBashPathForTests();
  assert.deepEqual(
    scriptLaunch(String.raw`C:\plugins\run-loop.sh`, ["C:/w"], "win32"),
    {
      command: process.execPath,
      args: ["C:/plugins/run-loop.sh", "C:/w"],
    }
  );
});

test("applyWindowsLoopEnv leaves other platforms alone", () => {
  const env = { AGENTFLOW_WORKDIR: String.raw`C:\w` };
  assert.equal(applyWindowsLoopEnv(env, "linux"), env);
});

test("applyWindowsLoopEnv adds Git Bash, UTF-8 Python and slash paths", () => {
  process.env[GIT_BASH_PATH_ENV] = process.execPath;
  resetGitBashPathForTests();
  const env = applyWindowsLoopEnv(
    {
      AGENTFLOW_WORKDIR: String.raw`C:\work\loop`,
      AGENTFLOW_PLUGIN_DIRS: [
        String.raw`C:\p\code`,
        String.raw`C:\p\judges`,
      ].join("\n"),
      AGENTFLOW_API_URL: "https://agentflow.example.test",
      CLAUDE_BIN: String.raw`C:\Users\dev\.local\bin\claude.exe`,
      [WINDOWS_SHIMS_DIR_ENV]: String.raw`C:\data\shims`,
      SystemRoot: String.raw`C:\Windows`,
      PythonPath: String.raw`C:\lib`,
    },
    "win32"
  );
  assert.equal(env.AGENTFLOW_WORKDIR, "C:/work/loop");
  assert.equal(env.AGENTFLOW_PLUGIN_DIRS, "C:/p/code\nC:/p/judges");
  assert.equal(env.AGENTFLOW_API_URL, "https://agentflow.example.test");
  assert.equal(env.CLAUDE_BIN, "C:/Users/dev/.local/bin/claude.exe");
  assert.equal(env.SystemRoot, String.raw`C:\Windows`);
  assert.equal(env[CLAUDE_CODE_GIT_BASH_PATH_ENV], process.execPath);
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONPATH, String.raw`C:\data\shims\python;C:\lib`);
  assert.equal(env.PythonPath, undefined);
});

test("killProcessTree signals the process group outside Windows", () => {
  const calls: unknown[][] = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    return true;
  }) as typeof process.kill;
  try {
    killProcessTree(4321, "SIGTERM", "linux");
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(calls, [[-4321, "SIGTERM"]]);
});
