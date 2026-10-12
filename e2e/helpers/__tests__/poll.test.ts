import { describe, expect, it } from "vitest";
import { PollAbortError, pollUntil } from "../poll";

const RE_TIMEOUT_MESSAGE =
  /Timed out after 20ms waiting for a server\. Last attempt: GET \/health Last error: connection refused/;

describe("pollUntil", () => {
  it("returns the first non-null value", async () => {
    let calls = 0;

    const value = await pollUntil(
      () => {
        calls += 1;
        return Promise.resolve(calls === 3 ? "ready" : null);
      },
      { description: "the third call", timeoutMs: 2000, intervalMs: 1 }
    );

    expect(value).toBe("ready");
    expect(calls).toBe(3);
  });

  it("treats a throwing probe as a miss and reports it on timeout", async () => {
    await expect(
      pollUntil(() => Promise.reject(new Error("connection refused")), {
        description: "a server",
        timeoutMs: 20,
        intervalMs: 5,
        describeLastAttempt: () => "GET /health",
      })
    ).rejects.toThrow(RE_TIMEOUT_MESSAGE);
  });

  it("stops immediately on PollAbortError", async () => {
    let calls = 0;

    await expect(
      pollUntil(
        () => {
          calls += 1;
          return Promise.reject(new PollAbortError("run failed"));
        },
        { description: "a run", timeoutMs: 2000, intervalMs: 1 }
      )
    ).rejects.toThrow("run failed");
    expect(calls).toBe(1);
  });
});
