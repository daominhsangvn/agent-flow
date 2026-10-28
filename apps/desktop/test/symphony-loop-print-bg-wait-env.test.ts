/**
 * Spawn-env test: a loop's Claude Code waits for its background subagents
 * (loop-claude-env.ts). Without CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0, print
 * mode stopped a plan-draft-writer still running 10 minutes after the
 * orchestrator's last turn, and the PLAN loop failed without a plan.json.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { LoopClaudeEnvVar } from "../src/server/operations/loop-claude-env.js";
import { setShellPathForTest } from "../src/server/shell-path.js";
import { writeFakeClaudeScript } from "./helpers/fake-harness-artifacts.js";
import {
  makeFakeWorktreeProvider,
  makeMultiRepoGateway,
  makeMultiRepoTestHarness,
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/print-bg-wait-env-test"
);

const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
  makeMultiRepoTestHarness();
afterEach(cleanup);

test("a PLAN loop runs Claude Code with no background wait ceiling", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentflow-print-bg-wait-")
  );
  tempPathsToClean.push(tmpDir);
  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.AGENTFLOW_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const captureFile = path.join(tmpDir, "captured-ceiling.txt");
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await writeFakeClaudeScript(
    fakeBin,
    [
      "#!/bin/sh",
      `printf '%s' "$${LoopClaudeEnvVar.PrintBackgroundWaitCeilingMs}" > ${JSON.stringify(captureFile)}`,
      "cat > /dev/null",
      `echo '{"type":"result"}'`,
      "exit 0",
    ].join("\n")
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await makeMultiRepoGateway({
    tmpDir,
    mockPort: mock.port,
    machineName: "print-bg-wait-env-test",
    worktreeProvider: fakeWorktreeProvider,
    serversToClose,
  });

  const loopId = "00000000-0000-4000-8000-000000007311";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        agentFlowAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `print-bg-wait/${path.basename(primaryRepo)}`,
          branch: "main",
        },
      }),
    }
  );
  assert.equal(response.status, 200, await response.text());
  await waitForTerminalEvent(mock.requests, loopId);

  assert.equal((await fs.readFile(captureFile, "utf-8")).trim(), "0");
});
