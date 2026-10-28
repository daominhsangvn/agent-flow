import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  type LoopStepConfig,
  LoopStepFinish,
} from "@agentflow-ai/loops-api/loop-step";
import type { SupportedRuntimeSelection } from "../src/server/operations/harness-pipeline.js";
import {
  ATTACH_HELPER_FILE,
  integrationMcpConfig,
  openLoopIntegrationSession,
  writeAttachHelper,
} from "../src/server/operations/integration-session-client.js";
import {
  buildStepLaunch,
  prepareStepIntegrationTools,
  STEP_MCP_CONFIG_FILE,
  withIntegrationToolArgs,
} from "../src/server/operations/loop-step.js";

/**
 * A process step whose grant gives its agent integration tools: the loop's
 * runner exchanges the loop for a session token (with the loop's own token),
 * writes an MCP config that reads it from the environment and adds the
 * server's tools to the agent's allowed tools.
 */

const GRANT = {
  token: "ist_step-session-token-0123456789",
  expiresAt: "2026-10-14T09:00:00.000Z",
  mcpUrl: "http://mcp.test/mcp",
};
const FILES_URL = "http://api.test/integration-tools/files";
const NOT_OPENED_RE =
  /The step's integration tools could not be opened: AgentFlow answered 404/;

let root: string;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-step-tools-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function step(integrationTools: boolean): LoopStepConfig {
  return {
    runId: "run-1",
    stepId: "investigate",
    name: "Investigate",
    fresh: true,
    askQuestions: false,
    artifacts: [],
    finish: LoopStepFinish.None,
    toolkit: null,
    integrationTools,
  };
}

describe("prepareStepIntegrationTools", () => {
  test("opens the session and writes an MCP config without the token", async () => {
    const tools = await prepareStepIntegrationTools({
      step: step(true),
      claudeWorkDir: root,
      openSession: () => Promise.resolve(GRANT),
      mcpConfig: integrationMcpConfig,
    });

    const file = path.join(root, STEP_MCP_CONFIG_FILE);
    assert.deepEqual(tools, {
      args: ["--mcp-config", file],
      env: { AGENTFLOW_INTEGRATION_TOKEN: GRANT.token },
    });
    const config = readFileSync(file, "utf8");
    assert.ok(config.includes(GRANT.mcpUrl));
    assert.ok(!config.includes(GRANT.token), "the token stays out of files");
  });

  test("hands the agent the upload helper when the session can take files", async () => {
    const dir = mkdtempSync(path.join(root, "files-"));
    const tools = await prepareStepIntegrationTools({
      step: step(true),
      claudeWorkDir: dir,
      openSession: () => Promise.resolve({ ...GRANT, filesUrl: FILES_URL }),
      mcpConfig: integrationMcpConfig,
    });

    const helper = path.join(dir, ATTACH_HELPER_FILE);
    assert.deepEqual(tools.env, {
      AGENTFLOW_INTEGRATION_TOKEN: GRANT.token,
      AGENTFLOW_INTEGRATION_FILES_URL: FILES_URL,
      AGENTFLOW_ATTACH: helper,
    });
    // Throws unless the helper is executable.
    accessSync(helper, constants.X_OK);
    assert.ok(
      !readFileSync(helper, "utf8").includes(GRANT.token),
      "the token stays out of files"
    );
  });

  test("gives a step without a grant nothing", async () => {
    let opened = false;
    const tools = await prepareStepIntegrationTools({
      step: step(false),
      claudeWorkDir: root,
      openSession: () => {
        opened = true;
        return Promise.resolve(GRANT);
      },
      mcpConfig: integrationMcpConfig,
    });

    assert.deepEqual(tools, { args: [], env: {} });
    assert.equal(opened, false);
  });

  test("fails the step when the session cannot be opened", async () => {
    await assert.rejects(
      prepareStepIntegrationTools({
        step: step(true),
        claudeWorkDir: root,
        openSession: () => Promise.reject(new Error("AgentFlow answered 404")),
        mcpConfig: integrationMcpConfig,
      }),
      NOT_OPENED_RE
    );
  });
});

describe("withIntegrationToolArgs", () => {
  const base = ["-p", "--allowedTools", "Bash,Read", "--max-turns", "200"];

  test("allows the integration server's tools and loads its config", () => {
    assert.deepEqual(
      withIntegrationToolArgs(base, {
        args: ["--mcp-config", "/w/mcp.json"],
        env: {},
      }),
      [
        "-p",
        "--allowedTools",
        "Bash,Read,mcp__agentflow_integrations",
        "--max-turns",
        "200",
        "--mcp-config",
        "/w/mcp.json",
      ]
    );
  });

  test("keeps the args of a step without tools", () => {
    assert.deepEqual(
      withIntegrationToolArgs(base, { args: [], env: {} }),
      base
    );
  });
});

const MCP_THEN_PROMPT_RE = /'--mcp-config' '[^']+' '--' '\/investigate'/;

describe("buildStepLaunch with integration tools", () => {
  test("asks for the loop's session and hands the agent its tools", async () => {
    const asked: unknown[] = [];
    const launch = await buildStepLaunch({
      body: {
        command: LoopCommand.Step,
        loopId: "loop-1",
        agentFlowAuthToken: "loop-runner-jwt",
        prompt: "/investigate",
        step: step(true),
      },
      runtime: claudeRuntime(),
      baseClaudeArgs: ["-p", "--allowedTools", "Read"],
      stdinClaudeArgs: ["-p", "-", "--allowedTools", "Read"],
      claudeWorkDir: root,
      harnessBin: "claude",
      apiBaseUrl: "http://api.test",
      openSession: (input) => {
        asked.push(input);
        return Promise.resolve(GRANT);
      },
    });

    assert.deepEqual(asked, [
      {
        apiBaseUrl: "http://api.test",
        loopId: "loop-1",
        token: "loop-runner-jwt",
      },
    ]);
    assert.deepEqual(launch.env, {
      AGENTFLOW_INTEGRATION_TOKEN: GRANT.token,
    });
    const command = launch.args.at(-1) ?? "";
    assert.ok(command.includes("'Read,mcp__agentflow_integrations'"));
    assert.ok(command.includes("'--mcp-config'"));
    assert.ok(!command.includes(GRANT.token));
    // `--mcp-config` takes several values: `--` keeps the prompt out of them.
    assert.match(command, MCP_THEN_PROMPT_RE);
  });
});

describe("openLoopIntegrationSession", () => {
  test("asks the API with the loop's token", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(Response.json({ success: true, data: GRANT }));
    }) as typeof fetch;

    const grant = await openLoopIntegrationSession({
      apiBaseUrl: "http://api.test/",
      loopId: "loop-1",
      token: "loop-runner-jwt",
      fetchImpl,
    });

    assert.equal(grant.token, GRANT.token);
    assert.equal(grant.filesUrl, "http://api.test/integration-tools/files");
    assert.equal(
      requests[0]?.url,
      "http://api.test/loops/loop-1/integration-session"
    );
    assert.deepEqual(requests[0]?.init?.headers, {
      Authorization: "Bearer loop-runner-jwt",
    });
  });
});

describe("the upload helper", () => {
  test("posts the file with the session's token and a safe name", async () => {
    const dir = mkdtempSync(path.join(root, "helper-"));
    const helper = await writeAttachHelper(dir);
    // A curl that prints its arguments, one per line.
    const bin = path.join(dir, "bin");
    execFileSync("mkdir", [bin]);
    writeFileSync(
      path.join(bin, "curl"),
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n'
    );
    chmodSync(path.join(bin, "curl"), 0o755);
    const evidence = path.join(dir, "login error (1).png");
    writeFileSync(evidence, "png");

    const output = execFileSync(helper, [evidence, "image/png"], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        AGENTFLOW_INTEGRATION_TOKEN: GRANT.token,
        AGENTFLOW_INTEGRATION_FILES_URL: FILES_URL,
      },
      encoding: "utf8",
    });

    assert.deepEqual(output.trim().split("\n"), [
      "-sS",
      "-X",
      "POST",
      FILES_URL,
      "-H",
      `Authorization: Bearer ${GRANT.token}`,
      "-H",
      "Content-Type: image/png",
      "-H",
      "x-file-name: login_error__1_.png",
      "--data-binary",
      `@${evidence}`,
    ]);
  });

  test("says how to call it without a file", async () => {
    const helper = await writeAttachHelper(
      mkdtempSync(path.join(root, "usage-"))
    );

    assert.throws(
      () =>
        execFileSync(helper, [], {
          stdio: "pipe",
          env: { PATH: "/usr/bin:/bin" },
        }),
      (error: { status?: number; stderr?: Buffer }) =>
        error.status === 2 && String(error.stderr).includes("usage:")
    );
  });
});

function claudeRuntime(): SupportedRuntimeSelection {
  return {
    ok: true,
    harness: { adapter: { harness: LoopHarness.Claude } },
  } as unknown as SupportedRuntimeSelection;
}
