import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  prepareWindowsTools,
  type WindowsToolsDeps,
  windowsToolOverrides,
} from "../src/headless/headless-windows-tools.js";
import {
  GIT_BASH_PATH_ENV,
  WINDOWS_SHIMS_DIR_ENV,
} from "../src/server/platform-shell.js";

const DATA_DIR = path.resolve("/runner-data");
const PYTHON = String.raw`C:\Python312\python.exe`;
const JQ = String.raw`C:\Users\Dev\AppData\Local\Microsoft\WinGet\Links\jq.exe`;
const GIT_BASH = String.raw`C:\Program Files\Git\bin\bash.exe`;
const LF_NEWLINE_RE = /reconfigure\(newline="\\n"\)/;

function fakeDeps(options: {
  pythonFrom?: string;
  jq?: string | null;
}): WindowsToolsDeps & { files: Map<string, string>; probes: string[] } {
  const files = new Map<string, string>();
  const probes: string[] = [];
  return {
    files,
    probes,
    env: { [GIT_BASH_PATH_ENV]: GIT_BASH },
    probePython: (command, args) => {
      probes.push([command, ...args].join(" "));
      return Promise.resolve(command === options.pythonFrom ? PYTHON : null);
    },
    findOnPath: (name) =>
      Promise.resolve(name === "jq" ? (options.jq ?? null) : null),
    isFile: (file) => file === GIT_BASH,
    writeFile: (file, content) => {
      files.set(file, content);
    },
  };
}

test("writes python3 and jq shims that run the tools found", async () => {
  const deps = fakeDeps({ pythonFrom: "py", jq: JQ });
  const tools = await prepareWindowsTools(DATA_DIR, deps);
  const shimsDir = path.join(DATA_DIR, "shims");

  assert.deepEqual(tools, {
    shimsDir,
    gitBash: GIT_BASH,
    python: PYTHON,
    jq: JQ,
  });
  assert.deepEqual(deps.probes, ["python3", "python", "py -3"]);
  assert.equal(deps.env[WINDOWS_SHIMS_DIR_ENV], shimsDir);
  assert.equal(
    deps.files.get(path.join(shimsDir, "python3")),
    "#!/usr/bin/env bash\nexec 'C:/Python312/python.exe' \"$@\"\n"
  );
  assert.equal(
    deps.files.get(path.join(shimsDir, "jq")),
    "#!/usr/bin/env bash\nexec 'C:/Users/Dev/AppData/Local/Microsoft/WinGet/Links/jq.exe' '--binary' \"$@\"\n"
  );
  assert.match(
    deps.files.get(path.join(shimsDir, "python", "sitecustomize.py")) ?? "",
    LF_NEWLINE_RE
  );
});

test("writes no shim for a tool that is missing", async () => {
  const deps = fakeDeps({});
  const tools = await prepareWindowsTools(DATA_DIR, deps);
  assert.equal(tools.python, null);
  assert.equal(tools.jq, null);
  assert.equal(deps.files.size, 0);
  assert.deepEqual(windowsToolOverrides(tools), {
    bash: GIT_BASH,
    python3: null,
    jq: null,
  });
});
