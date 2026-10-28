import assert from "node:assert/strict";
import os from "node:os";
import { afterEach, describe, test } from "node:test";
import { CheckSeverity } from "@agentflow-ai/loops-api/compute-target";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { _setRunCommandForTesting } from "../src/server/operations/health-check.js";
import { CLAUDE_AUTH_CHECK_ID } from "../src/server/operations/health-check-claude-auth.js";
import type { SystemCheckHostOptions } from "../src/server/operations/health-check-runner.js";
import { registerSystemCheckRoutes } from "../src/server/operations/system-check-routes.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  dispatchHealthCheck,
  findAppVersion,
  findCheck,
  parsePayload,
} from "./fixtures/health-check-route.js";

const EXPECTED_MCP_URL = "http://localhost:3010/mcp";
const RUNNER_VERSION = "0.16.69";
const PROXY_HOST = "claude-proxy.example.com";
afterEach(() => {
  _setRunCommandForTesting();
});

/** The System Check routes of a gateway on `host`, with every binary present. */
function register(host: SystemCheckHostOptions | undefined) {
  _setRunCommandForTesting(() => Promise.resolve({ stdout: "1.0.0" }));
  const dispatcher = new OperationDispatcher();
  registerSystemCheckRoutes(dispatcher, {
    processManager: {} as unknown as ProcessManager,
    getSymphonyDir: () => os.tmpdir(),
    getBinaryPaths: () => ({
      claude: "/usr/bin/true",
      git: "/usr/bin/true",
      python3: "/usr/bin/true",
    }),
    getAppVersion: () => RUNNER_VERSION,
    isPackagedBuild: () => false,
    host,
  });
  return dispatcher;
}

async function healthCheck(host: SystemCheckHostOptions | undefined) {
  return parsePayload(
    await dispatchHealthCheck(register(host), {
      expectedMcpUrl: EXPECTED_MCP_URL,
      latestVersion: "9.9.9",
    })
  );
}

describe("System Check on a headless runner", () => {
  test("has no MCP rows: a runner never uses the AgentFlow MCP server or Codex", async () => {
    const payload = await healthCheck({ headlessRunner: true });

    assert.deepEqual(payload.mcpServers, {});
  });

  test("passes Claude authentication with the model provider set in AgentFlow", async () => {
    const payload = await healthCheck({
      headlessRunner: true,
      getAgentFlowModelProvider: () => Promise.resolve({ host: PROXY_HOST }),
    });
    const auth = findCheck(payload, CLAUDE_AUTH_CHECK_ID);

    assert.equal(auth?.passed, true);
    assert.equal(auth?.severity, CheckSeverity.Passed);
    assert.equal(auth?.version, `AgentFlow model provider (${PROXY_HOST})`);
  });

  test("keeps the runner's own Claude row when AgentFlow has no provider or cannot be asked", async () => {
    const without = await healthCheck({ headlessRunner: true });
    const none = await healthCheck({
      headlessRunner: true,
      getAgentFlowModelProvider: () => Promise.resolve(null),
    });
    const unreachable = await healthCheck({
      headlessRunner: true,
      getAgentFlowModelProvider: () =>
        Promise.reject(new Error("fetch failed")),
    });

    const ownRow = findCheck(without, CLAUDE_AUTH_CHECK_ID);
    assert.ok(ownRow);
    assert.notEqual(ownRow.version, `AgentFlow model provider (${PROXY_HOST})`);
    assert.deepEqual(findCheck(none, CLAUDE_AUTH_CHECK_ID), ownRow);
    assert.deepEqual(findCheck(unreachable, CLAUDE_AUTH_CHECK_ID), ownRow);
  });

  test("reports its version as a local build, never against desktop releases", async () => {
    const version = findAppVersion(await healthCheck({ headlessRunner: true }));

    assert.equal(version?.severity, CheckSeverity.Passed);
    assert.equal(version?.error, undefined);
    assert.ok(version?.version?.startsWith(`${RUNNER_VERSION} (local build`));
  });

  test("leaves the desktop app's System Check as it was: MCP rows probed", async () => {
    const payload = await healthCheck(undefined);
    const mcpServers = payload.mcpServers as Record<string, unknown>;

    assert.ok(mcpServers.claude);
    assert.ok(mcpServers.codex);
  });
});
