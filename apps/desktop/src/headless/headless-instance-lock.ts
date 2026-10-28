/**
 * @file headless-instance-lock.ts
 * @description One runner process per data directory. The data directory
 * holds the runner's gateway identity (its compute target in AgentFlow), job
 * store and loop tokens; two processes on one directory would register as
 * the same computer and finalize each other's loops. It is not a limit on
 * runners: each personal runner has its project's own directory, and another
 * auto runner only needs its own AGENTFLOW_RUNNER_DATA_DIR.
 */

import fs from "node:fs";
import path from "node:path";

const LOCK_FILE_NAME = "runner.lock";
const PID_RE = /^\d+$/;

export type InstanceLock = { release(): void };

export type InstanceLockResult =
  | { ok: true; lock: InstanceLock }
  | { ok: false; error: string };

/**
 * Takes `<dataDir>/runner.lock` for this process. A lock left by a process
 * that no longer runs (a crash, a killed terminal) is taken over.
 */
export function acquireInstanceLock(
  dataDir: string,
  pid: number = process.pid,
  isRunning: (pid: number) => boolean = isProcessRunning
): InstanceLockResult {
  const file = path.join(dataDir, LOCK_FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return { ok: true, lock: { release: () => releaseLock(file, pid) } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const holder = readHolder(file);
    if (holder !== null && holder !== pid && isRunning(holder)) {
      return {
        ok: false,
        error: `Another runner (process ${holder}) already uses ${dataDir}, and two runners on one data directory would be the same computer in AgentFlow. Stop it, or give this one its own data directory (AGENTFLOW_RUNNER_DATA_DIR) or project (--project).`,
      };
    }
    fs.rmSync(file, { force: true });
  }
  return { ok: false, error: `Could not take the runner lock ${file}` };
}

function releaseLock(file: string, pid: number): void {
  if (readHolder(file) === pid) {
    fs.rmSync(file, { force: true });
  }
}

function readHolder(file: string): number | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return PID_RE.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs under another account.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
