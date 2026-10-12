import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_MAX_CONCURRENT_COMMANDS,
  DEFAULT_RUNNER_WORKSPACE,
  loadHeadlessConfig,
} from "../src/headless/headless-config.js";
import { HeadlessRunnerEnv } from "../src/headless/headless-env.js";
import { ALLOW_HTTP_HOSTS_ENV } from "../src/main/settings/origin-policy.js";

const API_KEY = "sk_live_test_key_value";
const DOCKER_HOST_API_URL = "http://host.docker.internal:3002";
const REJECTED_KEY = "not-a-key";
const REJECTED_KEY_RE = /not-a-key/;

function baseEnv(): NodeJS.ProcessEnv {
  return {
    [HeadlessRunnerEnv.ApiUrl]: "https://agentflow.example.test/",
    [HeadlessRunnerEnv.ApiKey]: API_KEY,
  };
}

test("applies defaults and normalizes the API URL to its origin", () => {
  const result = loadHeadlessConfig(baseEnv());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.apiUrl, "https://agentflow.example.test");
  assert.equal(result.config.webAppUrl, result.config.apiUrl);
  assert.equal(result.config.runnerName, os.hostname());
  assert.equal(
    result.config.workspaceDir,
    path.resolve(DEFAULT_RUNNER_WORKSPACE)
  );
  assert.equal(
    result.config.dataDir,
    path.resolve(path.join(os.homedir(), ".agentflow-runner"))
  );
  assert.equal(
    result.config.maxConcurrentCommands,
    DEFAULT_MAX_CONCURRENT_COMMANDS
  );
  assert.equal(result.config.gatewayPort, DEFAULT_GATEWAY_PORT);
  assert.equal(result.config.rewriteCallbackUrl, true);
  assert.equal(result.config.reportSessions, true);
});

test("reads every optional setting", () => {
  const result = loadHeadlessConfig({
    ...baseEnv(),
    [HeadlessRunnerEnv.WebAppUrl]: "https://app.example.test/path",
    [HeadlessRunnerEnv.RunnerName]: "  build-01  ",
    [HeadlessRunnerEnv.Workspace]: "/srv/work",
    [HeadlessRunnerEnv.DataDir]: "/srv/data",
    [HeadlessRunnerEnv.MaxConcurrent]: "4",
    [HeadlessRunnerEnv.GatewayPort]: "50000",
    [HeadlessRunnerEnv.RewriteCallbackUrl]: "false",
    [HeadlessRunnerEnv.ReportSessions]: "off",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.webAppUrl, "https://app.example.test");
  assert.equal(result.config.runnerName, "build-01");
  assert.equal(result.config.workspaceDir, path.resolve("/srv/work"));
  assert.equal(result.config.dataDir, path.resolve("/srv/data"));
  assert.equal(result.config.maxConcurrentCommands, 4);
  assert.equal(result.config.gatewayPort, 50_000);
  assert.equal(result.config.rewriteCallbackUrl, false);
  assert.equal(result.config.reportSessions, false);
});

test("treats empty variables as unset", () => {
  const result = loadHeadlessConfig({
    ...baseEnv(),
    [HeadlessRunnerEnv.RunnerName]: "   ",
    [HeadlessRunnerEnv.MaxConcurrent]: "",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.runnerName, os.hostname());
    assert.equal(
      result.config.maxConcurrentCommands,
      DEFAULT_MAX_CONCURRENT_COMMANDS
    );
  }
});

test("reports every invalid setting by variable name", () => {
  const result = loadHeadlessConfig({
    [HeadlessRunnerEnv.ApiUrl]: "ftp://example.test",
    [HeadlessRunnerEnv.ApiKey]: REJECTED_KEY,
    [HeadlessRunnerEnv.MaxConcurrent]: "0",
    [HeadlessRunnerEnv.RewriteCallbackUrl]: "maybe",
  });
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  const joined = result.errors.join("\n");
  for (const name of [
    HeadlessRunnerEnv.ApiUrl,
    HeadlessRunnerEnv.ApiKey,
    HeadlessRunnerEnv.MaxConcurrent,
    HeadlessRunnerEnv.RewriteCallbackUrl,
  ]) {
    assert.ok(joined.includes(name), name);
  }
  assert.doesNotMatch(joined, REJECTED_KEY_RE);
});

test("requires the API URL and key", () => {
  const result = loadHeadlessConfig({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.length, 2);
  }
});

test("refuses plain http to a non-loopback API unless the host is allowed", () => {
  const env = { ...baseEnv(), [HeadlessRunnerEnv.ApiUrl]: DOCKER_HOST_API_URL };
  const refused = loadHeadlessConfig(env);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.ok(refused.errors[0]?.includes(ALLOW_HTTP_HOSTS_ENV));
  }

  process.env[ALLOW_HTTP_HOSTS_ENV] = "host.docker.internal";
  try {
    const allowed = loadHeadlessConfig(env);
    assert.equal(allowed.ok, true);
  } finally {
    delete process.env[ALLOW_HTTP_HOSTS_ENV];
  }
});
