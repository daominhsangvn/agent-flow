import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  findLoopLeftoverProcesses,
  LOOP_PROCESS_TAG_ENV,
  stopLoopLeftoverProcesses,
} from "../src/server/operations/loop-leftover-processes.js";

// Background processes an agent starts (a test server) leave the loop's
// process group and outlived the loop on runners. They are found by the loop
// id the agent's environment carries and stopped when the agent exits.

const STOPPED_LOG_RE =
  /Stopped 2 leftover process\(es\).*120, 140.*killed: 140/;

let procRoot: string;

function fakeProcess(pid: number, env: Record<string, string>): void {
  const dir = path.join(procRoot, String(pid));
  mkdirSync(dir);
  const environ = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\0");
  writeFileSync(path.join(dir, "environ"), `${environ}\0`);
}

beforeEach(() => {
  procRoot = mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  fakeProcess(7, { PATH: "/usr/bin" });
  fakeProcess(120, { [LOOP_PROCESS_TAG_ENV]: "loop-a", PATH: "/usr/bin" });
  fakeProcess(130, { [LOOP_PROCESS_TAG_ENV]: "loop-b" });
  fakeProcess(140, { HOME: "/home/runner", [LOOP_PROCESS_TAG_ENV]: "loop-a" });
  mkdirSync(path.join(procRoot, "self"));
  writeFileSync(path.join(procRoot, "uptime"), "1 1");
});

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true });
});

describe("findLoopLeftoverProcesses", () => {
  test("finds only the processes tagged with the loop id", async () => {
    assert.deepEqual(
      await findLoopLeftoverProcesses("loop-a", procRoot),
      [120, 140]
    );
    assert.deepEqual(await findLoopLeftoverProcesses("loop-c", procRoot), []);
  });

  test("finds nothing without /proc", async () => {
    assert.deepEqual(
      await findLoopLeftoverProcesses("loop-a", path.join(procRoot, "none")),
      []
    );
  });
});

describe("stopLoopLeftoverProcesses", () => {
  test("terminates the loop's processes and kills the ones that stay", async () => {
    const signals: string[] = [];
    const logs: string[] = [];

    const stopped = await stopLoopLeftoverProcesses(
      "loop-a",
      (message) => logs.push(message),
      {
        platform: "linux",
        procRoot,
        kill: (pid, signal) => {
          signals.push(`${signal} ${pid}`);
          if (pid === 120) {
            rmSync(path.join(procRoot, "120"), { recursive: true });
          }
        },
        sleep: () => Promise.resolve(),
      }
    );

    assert.equal(stopped, 2);
    assert.deepEqual(signals, ["SIGTERM 120", "SIGTERM 140", "SIGKILL 140"]);
    assert.match(logs[0] ?? "", STOPPED_LOG_RE);
  });

  test("does nothing off Linux or without leftovers", async () => {
    const signals: string[] = [];
    const deps = {
      procRoot,
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push(`${signal} ${pid}`);
      },
      sleep: () => Promise.resolve(),
    };

    assert.equal(
      await stopLoopLeftoverProcesses("loop-a", () => undefined, {
        ...deps,
        platform: "darwin",
      }),
      0
    );
    assert.equal(
      await stopLoopLeftoverProcesses("loop-z", () => undefined, {
        ...deps,
        platform: "linux",
      }),
      0
    );
    assert.deepEqual(signals, []);
  });

  test("ignores a process that is already gone", async () => {
    const stopped = await stopLoopLeftoverProcesses("loop-b", () => undefined, {
      platform: "linux",
      procRoot,
      kill: () => {
        throw new Error("ESRCH");
      },
      sleep: () => Promise.resolve(),
    });

    assert.equal(stopped, 1);
  });
});
