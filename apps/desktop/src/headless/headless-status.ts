/**
 * @file headless-status.ts
 * @description The runner writes its connection state to
 * `<data dir>/status.json`; the container healthcheck
 * (headless-healthcheck.ts) reads it. A file keeps the healthcheck from
 * opening a port or a second connection to AgentFlow.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CloudSocketState } from "../shared/cloud-socket-error.js";

export const STATUS_FILE_NAME = "status.json";
/** The runner rewrites the file at least this often while it is running. */
export const STATUS_REFRESH_INTERVAL_MS = 30_000;
/** Older than this, the runner is considered hung. */
export const STATUS_STALE_AFTER_MS = 3 * STATUS_REFRESH_INTERVAL_MS;

const runnerStatusSchema = z.object({
  state: z.enum(CloudSocketState),
  computeTargetId: z.string().nullable(),
  error: z.string().nullable(),
  activeCommands: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

export function writeRunnerStatus(dataDir: string, status: RunnerStatus): void {
  const target = path.join(dataDir, STATUS_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function readRunnerStatus(dataDir: string): RunnerStatus | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, STATUS_FILE_NAME), "utf8");
    const parsed = runnerStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type HealthVerdict = { healthy: boolean; reason: string };

/** Healthy means connected to AgentFlow and still refreshing the file. */
export function evaluateRunnerHealth(
  status: RunnerStatus | null,
  now: Date
): HealthVerdict {
  if (!status) {
    return { healthy: false, reason: "no status file yet" };
  }
  const age = now.getTime() - Date.parse(status.updatedAt);
  if (!Number.isFinite(age) || age > STATUS_STALE_AFTER_MS) {
    return { healthy: false, reason: "status file is stale" };
  }
  if (status.state !== CloudSocketState.Online) {
    return {
      healthy: false,
      reason: `not connected (${status.state}${status.error ? `: ${status.error}` : ""})`,
    };
  }
  return { healthy: true, reason: `online as ${status.computeTargetId}` };
}
