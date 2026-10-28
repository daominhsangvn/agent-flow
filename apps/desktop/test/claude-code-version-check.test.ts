import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ClaudeCodeVersionChannel } from "@repo/api/src/types/compute-target-model-provider";
import { createClaudeCodeVersionCheck } from "../src/headless/claude-code-version-check.js";
import type { RunResult } from "../src/headless/claude-code-versions.js";
import { ClaudeCodeVersionMismatchError } from "../src/server/operations/claude-code-version-pin.js";

function setup(result: RunResult) {
  const state = { calls: 0, warnings: [] as string[] };
  const check = createClaudeCodeVersionCheck({
    claudePath: "/usr/bin/claude",
    homeDir: "/home/test",
    log: { warn: (message) => state.warnings.push(message) },
    run: () => {
      state.calls += 1;
      return Promise.resolve(result);
    },
  });
  return { check, state };
}

describe("createClaudeCodeVersionCheck", () => {
  test("latest is not checked", async () => {
    const { check, state } = setup({
      code: 0,
      stdout: "2.1.307 (Claude Code)\n",
      stderr: "",
    });
    assert.equal(await check.ensure(ClaudeCodeVersionChannel.Latest), null);
    assert.equal(state.calls, 0);
  });

  test("the same version passes", async () => {
    const { check } = setup({
      code: 0,
      stdout: "2.1.307 (Claude Code)\n",
      stderr: "",
    });
    assert.equal(await check.ensure("2.1.307"), null);
  });

  test("a different version fails with the install command", async () => {
    const { check } = setup({
      code: 0,
      stdout: "2.1.307 (Claude Code)\n",
      stderr: "",
    });
    await assert.rejects(
      check.ensure("2.1.311"),
      (error: unknown) =>
        error instanceof ClaudeCodeVersionMismatchError &&
        error.message ===
          "This computer runs Claude Code 2.1.307, the provider needs 2.1.311: run `claude install 2.1.311`"
    );
  });

  test("an unreadable version lets the loop run", async () => {
    const { check, state } = setup({ code: 1, stdout: "", stderr: "boom" });
    assert.equal(await check.ensure("2.1.311"), null);
    assert.equal(state.warnings.length, 1);
  });
});
