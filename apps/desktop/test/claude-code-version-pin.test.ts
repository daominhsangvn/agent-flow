import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  type ClaudeCodeVersionInstaller,
  configureClaudeCodeVersionInstaller,
  resolveLoopHarnessBinary,
} from "../src/server/operations/claude-code-version-pin.js";

const CLAUDE = { harness: LoopHarness.Claude, binaryName: LoopHarness.Claude };
const CODEX = { harness: LoopHarness.Codex, binaryName: LoopHarness.Codex };

/** Runs `body` with `installer` configured and two executables to point at. */
async function withInstaller(
  installer: ClaudeCodeVersionInstaller | null,
  body: (paths: { pinned: string; override: string }) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-pin-"));
  const pinned = path.join(dir, "2.1.290");
  const override = path.join(dir, "claude-override");
  for (const file of [pinned, override]) {
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  }
  configureClaudeCodeVersionInstaller(installer);
  try {
    await body({ pinned, override });
  } finally {
    configureClaudeCodeVersionInstaller(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveLoopHarnessBinary", () => {
  test("without an installer (desktop app) the override runs, version or not", async () => {
    await withInstaller(null, async ({ override }) => {
      const result = await resolveLoopHarnessBinary({
        adapter: CLAUDE,
        claudeCodeVersion: "2.1.290",
        override,
      });

      assert.deepEqual(result, {
        resolved: { path: override, source: "override" },
        error: null,
      });
    });
  });

  test("a headless runner runs the binary of the version the loop asks for", async () => {
    const requested: string[] = [];
    let pinnedPath = "";
    const installer: ClaudeCodeVersionInstaller = {
      ensure: (version) => {
        requested.push(version);
        return Promise.resolve({ version, binaryPath: pinnedPath });
      },
    };

    await withInstaller(installer, async ({ pinned, override }) => {
      pinnedPath = pinned;
      const result = await resolveLoopHarnessBinary({
        adapter: CLAUDE,
        claudeCodeVersion: "2.1.290",
        override,
      });

      assert.deepEqual(requested, ["2.1.290"]);
      assert.deepEqual(result, {
        resolved: { path: pinned, source: "override" },
        error: null,
      });
    });
  });

  test("a version that cannot be installed fails the loop with the reason", async () => {
    const installer: ClaudeCodeVersionInstaller = {
      ensure: () =>
        Promise.reject(new Error("claude install 9.9.9 failed (exit 1)")),
    };

    await withInstaller(installer, async ({ override }) => {
      const result = await resolveLoopHarnessBinary({
        adapter: CLAUDE,
        claudeCodeVersion: "9.9.9",
        override,
      });

      assert.equal(result.resolved.source, "fallback");
      assert.equal(
        result.error,
        "Claude Code 9.9.9 is not available on this runner: claude install 9.9.9 failed (exit 1)"
      );
    });
  });

  test("other harnesses, loops without a version and unpinnable versions keep the override", async () => {
    let calls = 0;
    const installer: ClaudeCodeVersionInstaller = {
      ensure: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    };

    await withInstaller(installer, async ({ override }) => {
      const codex = await resolveLoopHarnessBinary({
        adapter: CODEX,
        claudeCodeVersion: "2.1.290",
        override,
      });
      const noVersion = await resolveLoopHarnessBinary({
        adapter: CLAUDE,
        override,
      });
      const unpinned = await resolveLoopHarnessBinary({
        adapter: CLAUDE,
        claudeCodeVersion: "latest",
        override,
      });

      for (const result of [codex, noVersion, unpinned]) {
        assert.equal(result.resolved.path, override);
        assert.equal(result.error, null);
      }
      assert.equal(calls, 1);
    });
  });
});
