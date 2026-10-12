import { readdir, readFile } from "node:fs/promises";

/**
 * Processes an agent starts in the background during a loop (a dev server, a
 * file watcher) leave the loop's process group and session, so killing the
 * loop's group does not stop them and they outlive the loop: on a runner they
 * pile up across loops, holding ports and memory. Every loop's agent runs with
 * LOOP_PROCESS_TAG_ENV set to the loop id, which the processes it starts
 * inherit; when the agent exits, the processes still carrying the tag are
 * stopped. Linux only (it reads /proc); elsewhere nothing is stopped.
 */

export const LOOP_PROCESS_TAG_ENV = "AGENTFLOW_LOOP_ID";

/** Time leftover processes get to exit after SIGTERM before SIGKILL. */
export const LEFTOVER_KILL_GRACE_MS = 1500;

export type LeftoverProcessDeps = {
  platform: NodeJS.Platform;
  procRoot: string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_DEPS: LeftoverProcessDeps = {
  platform: process.platform,
  procRoot: "/proc",
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const PID_DIR_RE = /^\d+$/;

/** Pids of the running processes tagged with the loop id, lowest first. */
export async function findLoopLeftoverProcesses(
  loopId: string,
  procRoot: string = DEFAULT_DEPS.procRoot
): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const tag = `${LOOP_PROCESS_TAG_ENV}=${loopId}`;
  const found = await Promise.all(
    entries
      .filter((entry) => PID_DIR_RE.test(entry))
      .map(async (entry) => {
        const pid = Number(entry);
        if (pid === process.pid) {
          return null;
        }
        try {
          const environ = await readFile(
            `${procRoot}/${entry}/environ`,
            "utf8"
          );
          return environ.split("\0").includes(tag) ? pid : null;
        } catch {
          // Exited meanwhile, or not readable (another user's process).
          return null;
        }
      })
  );
  return found
    .filter((pid): pid is number => pid !== null)
    .sort((left, right) => left - right);
}

/**
 * Stops the loop's leftover processes: SIGTERM, then SIGKILL for those still
 * running after the grace period. Returns how many were found. Never throws.
 */
export async function stopLoopLeftoverProcesses(
  loopId: string,
  log: (message: string) => void,
  overrides: Partial<LeftoverProcessDeps> = {}
): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  if (deps.platform !== "linux") {
    return 0;
  }
  try {
    const pids = await findLoopLeftoverProcesses(loopId, deps.procRoot);
    if (pids.length === 0) {
      return 0;
    }
    signalAll(pids, "SIGTERM", deps.kill);
    await deps.sleep(LEFTOVER_KILL_GRACE_MS);
    const stillRunning = new Set(
      await findLoopLeftoverProcesses(loopId, deps.procRoot)
    );
    const survivors = pids.filter((pid) => stillRunning.has(pid));
    signalAll(survivors, "SIGKILL", deps.kill);
    log(
      `Stopped ${pids.length} leftover process(es) the agent left running: ${pids.join(", ")}${survivors.length > 0 ? ` (killed: ${survivors.join(", ")})` : ""}`
    );
    return pids.length;
  } catch (error) {
    log(`Could not stop the loop's leftover processes: ${String(error)}`);
    return 0;
  }
}

function signalAll(
  pids: readonly number[],
  signal: NodeJS.Signals,
  kill: LeftoverProcessDeps["kill"]
): void {
  for (const pid of pids) {
    try {
      kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
