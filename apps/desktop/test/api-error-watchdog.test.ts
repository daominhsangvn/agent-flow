import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  createApiErrorTracker,
  startApiErrorWatchdog,
} from "../src/server/operations/api-error-watchdog";

const STOP_AFTER_MS = 300_000;
const EXPIRED =
  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

const apiErrorResult = line({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 401,
  terminal_reason: "api_error",
  result: EXPIRED,
});
const turnResult = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Task 13 is committed.",
});
const assistant = line({ type: "assistant", message: { content: [] } });

describe("createApiErrorTracker", () => {
  test("an API error result followed by no output stalls after the grace period", () => {
    const tracker = createApiErrorTracker();
    tracker.push(turnResult + apiErrorResult, 1000);

    assert.equal(
      tracker.stalledError(1000 + STOP_AFTER_MS - 1, STOP_AFTER_MS),
      null
    );
    assert.equal(
      tracker.stalledError(1000 + STOP_AFTER_MS, STOP_AFTER_MS),
      EXPIRED
    );
  });

  test("output after the API error means the session went on", () => {
    const tracker = createApiErrorTracker();
    tracker.push(apiErrorResult, 1000);
    tracker.push(assistant, 2000);

    assert.equal(
      tracker.stalledError(1000 + STOP_AFTER_MS * 2, STOP_AFTER_MS),
      null
    );
  });

  test("an ordinary result or a failed tool never stalls", () => {
    const tracker = createApiErrorTracker();
    tracker.push(
      turnResult +
        line({ type: "result", is_error: true, result: "Tool failed" }),
      1000
    );

    assert.equal(
      tracker.stalledError(1000 + STOP_AFTER_MS * 2, STOP_AFTER_MS),
      null
    );
  });

  test("waits for a wakeup the agent scheduled before the error", () => {
    const tracker = createApiErrorTracker();
    const heartbeat = line({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delaySeconds: 1800, prompt: "Continue." },
          },
        ],
      },
    });
    tracker.push(heartbeat, 0);
    tracker.push(apiErrorResult, 840_000);

    assert.equal(
      tracker.stalledError(1_800_000 + STOP_AFTER_MS - 1, STOP_AFTER_MS),
      null
    );
    assert.equal(
      tracker.stalledError(1_800_000 + STOP_AFTER_MS, STOP_AFTER_MS),
      EXPIRED
    );
  });

  test("reads a line split across two reads", () => {
    const tracker = createApiErrorTracker();
    const half = Math.floor(apiErrorResult.length / 2);
    tracker.push(apiErrorResult.slice(0, half), 1000);
    tracker.push(apiErrorResult.slice(half), 1500);

    assert.equal(
      tracker.stalledError(1500 + STOP_AFTER_MS, STOP_AFTER_MS),
      EXPIRED
    );
  });
});

describe("startApiErrorWatchdog", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "api-error-watchdog-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("reports the stalled agent once, ignoring output from before the process", async () => {
    const output = path.join(dir, "claude-output.jsonl");
    writeFileSync(output, apiErrorResult);
    const startOffset = apiErrorResult.length;
    appendFileSync(output, turnResult + apiErrorResult);

    const errors: string[] = [];
    const stalled = new Promise<void>((resolve) => {
      const stop = startApiErrorWatchdog({
        outputPath: output,
        startOffset,
        stopAfterMs: 0,
        pollMs: 5,
        onStalled: (error) => {
          errors.push(error);
          stop();
          resolve();
        },
      });
    });
    await stalled;

    assert.deepEqual(errors, [EXPIRED]);
  });
});
