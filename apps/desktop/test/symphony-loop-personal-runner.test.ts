/**
 * The personal runner's STEP loop through the real gateway: the agent runs in
 * the project folder with this computer's credentials, gets the step's
 * instructions in its system prompt, and its questions are uploaded; loops
 * of another project are refused.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import {
  type LoopStepConfig,
  LoopStepFinish,
  LoopStepRole,
} from "@agentflow-ai/loops-api/loop-step";
import { configurePersonalRunnerProject } from "../src/server/operations/personal-runner.js";
import { resetResolvedClaudePath } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { resetShellPathCache } from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  restoreEnv,
  saveEnv,
  setupStubClaude,
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const SYSTEM_PROMPT_ARG = "--append-system-prompt";
const CREDENTIAL_ENV_RE = /AGENTFLOW_GIT_CREDENTIAL_URL|GIT_CONFIG_COUNT/;
const OTHER_PROJECT_RE = /runs only project PRO-1/;

function step(runId = "run-1"): LoopStepConfig {
  return {
    runId,
    stepId: "clarify",
    name: "Clarify",
    fresh: true,
    askQuestions: true,
    artifacts: [],
    finish: LoopStepFinish.None,
    toolkit: null,
  };
}

describe("personal runner STEP loops", () => {
  const servers: DesktopGatewayServer[] = [];
  const mocks: http.Server[] = [];
  const tempPaths: string[] = [];
  let savedEnv: Record<string, string | undefined> | undefined;

  afterEach(async () => {
    configurePersonalRunnerProject(null);
    if (savedEnv !== undefined) {
      restoreEnv(savedEnv);
      savedEnv = undefined;
    }
    resetShellPathCache();
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    for (const mock of mocks.splice(0)) {
      await new Promise<void>((resolve) => mock.close(() => resolve()));
    }
    for (const dir of tempPaths.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function startGateway(options: { parallel?: boolean } = {}) {
    savedEnv = saveEnv();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-loop-"));
    tempPaths.push(tmpDir);
    const projectDir = path.join(tmpDir, "brenock");
    const capture = path.join(tmpDir, "capture");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(capture, { recursive: true });
    await fs.writeFile(path.join(projectDir, "CLAUDE.md"), "# Mine\n");
    process.env.HOME = tmpDir;
    process.env.AGENTFLOW_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    resetResolvedClaudePath();
    await setupStubClaude(tmpDir, [
      "#!/bin/sh",
      `pwd > '${capture}/cwd.txt'`,
      `printf '%s\\n' "$@" > '${capture}/args.txt'`,
      `env > '${capture}/env.txt'`,
      // Long enough for a second loop to start while this one runs; the
      // question names the run's work directory.
      "sleep 1",
      `printf '[{"id":"q1","question":"Which export format for %s?"}]' "$(basename "$AGENTFLOW_WORKDIR")" > "$AGENTFLOW_WORKDIR/questions.json"`,
      `echo '{"type":"system","subtype":"init","session_id":"s-1"}'`,
      `echo '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}'`,
      `echo '{"type":"result","subtype":"success","session_id":"s-1","result":"","is_error":false}'`,
      "exit 0",
    ]);
    configurePersonalRunnerProject({
      projectKey: "PRO-1",
      projectDir,
      parallel: options.parallel ?? false,
      skipPermissions: false,
    });
    const mock = await startMockApiServer();
    mocks.push(mock.server);
    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getAllowedDirectories: () => [projectDir],
      machineName: "personal-runner-test",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
      getSymphonyDir: () => path.join(projectDir, ".agentflow-ai"),
      getGatewayId: () => "test-gateway-id",
    });
    servers.push(server);
    await server.start();
    const post = (body: Record<string, unknown>) =>
      fetch(
        `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: LoopCommand.Step,
            agentFlowAuthToken: "tok",
            prompt: "/speckit.clarify-all BREP-12",
            artifacts: [],
            step: step(),
            ...body,
          }),
        }
      );
    return { projectDir, capture, mock, post };
  }

  test("runs the step in the project folder with the computer's credentials", async () => {
    const { projectDir, capture, mock, post } = await startGateway();
    const loopId = "22220000-0000-0000-0000-000000000001";

    const response = await post({
      loopId,
      projectKey: "pro-1",
      repo: {
        fullName: "acme/brenock",
        branch: "develop",
        cloneUrl: "https://git.example.test/acme/brenock.git",
      },
    });
    assert.equal(response.ok, true, await response.text());
    const terminal = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(terminal.type, "completed", JSON.stringify(terminal));

    const cwd = readFileSync(path.join(capture, "cwd.txt"), "utf8").trim();
    assert.equal(await fs.realpath(cwd), await fs.realpath(projectDir));
    const args = readFileSync(path.join(capture, "args.txt"), "utf8");
    assert.ok(args.includes(SYSTEM_PROMPT_ARG));
    assert.doesNotMatch(
      readFileSync(path.join(capture, "env.txt"), "utf8"),
      CREDENTIAL_ENV_RE
    );
    assert.equal(
      readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8"),
      "# Mine\n"
    );
    assert.equal(existsSync(path.join(projectDir, ".claude")), false);
    assert.ok(
      existsSync(
        path.join(projectDir, ".agentflow-ai", "runs", "run-1", "issue.md")
      )
    );
    const upload = mock.requests.find((request) =>
      request.url.includes("upload-artifacts")
    );
    assert.ok(upload?.body.includes("Which export format for run-1?"));
  });

  test("tells a plan step to write the plan in the run's work directory", async () => {
    const { projectDir, capture, mock, post } = await startGateway();
    const loopId = "22220000-0000-0000-0000-000000000003";

    const response = await post({
      loopId,
      projectKey: "PRO-1",
      step: { ...step("run-plan"), role: LoopStepRole.Plan },
    });
    assert.equal(response.ok, true, await response.text());
    await waitForTerminalEvent(mock.requests, loopId);

    const args = readFileSync(path.join(capture, "args.txt"), "utf8");
    const workDir = path.join(projectDir, ".agentflow-ai", "runs", "run-plan");
    assert.ok(args.includes(`write it to \`${workDir}/plan.md\``), args);
  });

  test("parallel runs keep their own work directory and questions", async () => {
    const { projectDir, mock, post } = await startGateway({ parallel: true });
    const loops = [
      { loopId: "22220000-0000-0000-0000-000000000011", runId: "run-a" },
      { loopId: "22220000-0000-0000-0000-000000000012", runId: "run-b" },
    ];

    const responses = await Promise.all(
      loops.map(({ loopId, runId }) =>
        post({ loopId, projectKey: "PRO-1", step: step(runId) })
      )
    );
    assert.deepEqual(
      responses.map((response) => response.ok),
      [true, true]
    );
    for (const { loopId, runId } of loops) {
      const terminal = await waitForTerminalEvent(mock.requests, loopId);
      assert.equal(terminal.type, "completed", JSON.stringify(terminal));
      const upload = mock.requests.find((request) =>
        request.url.includes(`/loops/${loopId}/upload-artifacts`)
      );
      assert.ok(upload?.body.includes(`Which export format for ${runId}?`));
      const other = runId === "run-a" ? "run-b" : "run-a";
      assert.ok(!upload?.body.includes(`Which export format for ${other}?`));
      assert.ok(
        existsSync(
          path.join(projectDir, ".agentflow-ai", "runs", runId, "issue.md")
        )
      );
    }
  });

  test("one at a time: refuses a second loop while one runs", async () => {
    const { mock, post } = await startGateway();
    const first = "22220000-0000-0000-0000-000000000021";
    const second = "22220000-0000-0000-0000-000000000022";

    assert.equal((await post({ loopId: first, projectKey: "PRO-1" })).ok, true);
    const busy = await post({
      loopId: second,
      projectKey: "PRO-1",
      step: step("run-2"),
    });

    assert.equal(busy.status, 409);
    await waitForTerminalEvent(mock.requests, first);
  });

  test("refuses a loop of another project", async () => {
    const { capture, mock, post } = await startGateway();
    const loopId = "22220000-0000-0000-0000-000000000002";

    const response = await post({ loopId, projectKey: "PRO-2" });

    assert.equal(response.status, 409);
    const terminal = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(terminal.type, "error");
    assert.match(String(terminal.message), OTHER_PROJECT_RE);
    assert.equal(existsSync(path.join(capture, "cwd.txt")), false);
  });
});
