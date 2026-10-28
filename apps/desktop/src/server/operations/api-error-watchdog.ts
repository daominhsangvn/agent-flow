/**
 * @file api-error-watchdog.ts
 * @description Stops a loop's agent that waits forever after a model API
 * error. A loop's `claude -p` waits for its background subagents without a
 * ceiling (loop-claude-env.ts). When the model provider rejects the agent (an
 * expired token, a quota, an overload) the main turn ends with an API error
 * result and the subagents fail the same way, so nothing wakes the session
 * again: the process stays alive with no output and the run never settles.
 * The watchdog reads the stream output; an API error result followed by no
 * output for the grace period stops the process. Its completion then reports
 * the loop failed with the API error (an auth challenge), and the run can
 * retry the step. A wakeup the agent scheduled (ScheduleWakeup, its fallback
 * heartbeat) can still resume the session once the provider recovers, so
 * the grace period runs from the latest scheduled wakeup when that is later.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { z } from "zod";

/** Output-free time after an API error result before the agent is stopped. */
export const API_ERROR_STOP_AFTER_MS = 5 * 60_000;
const POLL_MS = 5000;
const READ_CHUNK_BYTES = 256 * 1024;

/** The result of a turn the model API ended (`terminal_reason: api_error`). */
const apiErrorResultSchema = z
  .object({
    type: z.literal("result"),
    is_error: z.literal(true),
    terminal_reason: z.string().optional(),
    api_error_status: z.number().nullable().optional(),
    result: z.unknown().optional(),
  })
  .refine(
    (record) =>
      record.terminal_reason === "api_error" ||
      typeof record.api_error_status === "number"
  );

/** An assistant event; its ScheduleWakeup calls say when the session wakes. */
const assistantEventSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});
const scheduleWakeupSchema = z.object({
  type: z.literal("tool_use"),
  name: z.literal("ScheduleWakeup"),
  input: z.object({ delaySeconds: z.number().positive() }),
});

export type ApiErrorWatchdogOptions = {
  /** The agent's stream-json output (claude-output.jsonl). */
  outputPath: string;
  /** Bytes of the file written before this process started. */
  startOffset: number;
  /** Called once, with the API error, when the agent should be stopped. */
  onStalled: (error: string) => void;
  stopAfterMs?: number;
  pollMs?: number;
  now?: () => number;
};

/** Starts watching; the returned function stops the watchdog. */
export function startApiErrorWatchdog(
  options: ApiErrorWatchdogOptions
): () => void {
  const stopAfterMs = options.stopAfterMs ?? API_ERROR_STOP_AFTER_MS;
  const now = options.now ?? Date.now;
  const tracker = createApiErrorTracker();
  let offset = options.startOffset;
  let stopped = false;

  const timer = setInterval(() => {
    const read = readNewOutput(options.outputPath, offset);
    offset = read.offset;
    tracker.push(read.text, now());
    const stalled = tracker.stalledError(now(), stopAfterMs);
    if (stalled !== null && !stopped) {
      stop();
      options.onStalled(stalled);
    }
  }, options.pollMs ?? POLL_MS);
  timer.unref?.();

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}

/**
 * The state the watchdog keeps over the output: the last API error result
 * and when it was written, cleared by any later output line, and when the
 * latest wakeup the agent scheduled is due.
 */
export function createApiErrorTracker() {
  let partial = "";
  let error: { message: string; at: number } | null = null;
  let wakeupDueAt = 0;
  return {
    push(text: string, at: number): void {
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const record = parseJsonLine(line);
        const message = apiErrorMessage(record);
        error = message === null ? null : { message, at };
        wakeupDueAt = Math.max(wakeupDueAt, scheduledWakeupDueAt(record, at));
      }
    },
    /**
     * The API error when nothing followed it, nor the latest scheduled
     * wakeup, for `stopAfterMs`.
     */
    stalledError(at: number, stopAfterMs: number): string | null {
      if (!error) {
        return null;
      }
      const quietSince = Math.max(error.at, wakeupDueAt);
      return at - quietSince >= stopAfterMs ? error.message : null;
    },
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The error of an API error result, else null. */
function apiErrorMessage(record: unknown): string | null {
  const parsed = apiErrorResultSchema.safeParse(record);
  if (!parsed.success) {
    return null;
  }
  const { result, api_error_status: status } = parsed.data;
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  return `Model API error${typeof status === "number" ? ` (HTTP ${status})` : ""}`;
}

/** When the latest wakeup an assistant event schedules is due (0: none). */
function scheduledWakeupDueAt(record: unknown, at: number): number {
  const event = assistantEventSchema.safeParse(record);
  if (!event.success) {
    return 0;
  }
  let due = 0;
  for (const block of event.data.message.content) {
    const wakeup = scheduleWakeupSchema.safeParse(block);
    if (wakeup.success) {
      due = Math.max(due, at + wakeup.data.input.delaySeconds * 1000);
    }
  }
  return due;
}

function readNewOutput(
  outputPath: string,
  offset: number
): { text: string; offset: number } {
  let size: number;
  try {
    size = statSync(outputPath).size;
  } catch {
    return { text: "", offset };
  }
  if (size <= offset) {
    return { text: "", offset: Math.min(offset, size) };
  }
  const length = Math.min(size - offset, READ_CHUNK_BYTES);
  const buffer = Buffer.alloc(length);
  let fd: number | null = null;
  try {
    fd = openSync(outputPath, "r");
    const read = readSync(fd, buffer, 0, length, offset);
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      offset: offset + read,
    };
  } catch {
    return { text: "", offset };
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}
