import { describe, expect, it } from "vitest";
import {
  forkUnsupportedMessage,
  runnerForksSession,
} from "./runner-fork-session";

describe("runnerForksSession", () => {
  it("accepts loopStepForkSession true", () => {
    expect(runnerForksSession({ loopStepForkSession: true })).toBe(true);
  });

  it.each([
    {},
    null,
    { loopStepForkSession: "true" },
    { loopStepForkSession: false },
  ])("rejects %j", (value) => {
    expect(runnerForksSession(value)).toBe(false);
  });
});

describe("forkUnsupportedMessage", () => {
  it("names the runner, or falls back", () => {
    const base = { session: "the session", advice: "Update." };
    expect(forkUnsupportedMessage({ ...base, machineName: "r1" })).toBe(
      "r1 runs a runner version that cannot fork a session: it would continue the session itself. Update."
    );
    expect(forkUnsupportedMessage({ ...base, machineName: null })).toContain(
      "The runner runs"
    );
  });
});
