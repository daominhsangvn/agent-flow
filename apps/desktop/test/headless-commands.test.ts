import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHeadlessCommand,
  HEADLESS_RUNNER_OPERATION_IDS,
  HeadlessCommandRejection,
  rewriteLoopCallbackUrl,
} from "../src/headless/headless-commands.js";
import type { DesktopCommandEvent } from "../src/main/cloud/cloud-protocol.js";
import { PROTOCOL_VERSION } from "../src/main/cloud/cloud-protocol.js";

const RUNNER_API_URL = "http://host.docker.internal:3002";
const LOOP_PATH = "/api/gateway/symphony/loop";

function command(path: string, body?: unknown): DesktopCommandEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message-1",
    timestamp: new Date(0).toISOString(),
    commandId: "cmd-1",
    operationId: "symphony_loop",
    method: "POST",
    path,
    body,
  };
}

test("accepts loop, kill, status, logs and health check commands", () => {
  const paths = [
    LOOP_PATH,
    "/api/gateway/symphony/loop/kill",
    "/api/gateway/symphony/status/loop-1",
    "/api/gateway/symphony/logs/loop-1",
    "/api/gateway/health-check",
  ];
  for (const path of paths) {
    const decision = classifyHeadlessCommand(path);
    assert.equal(decision.accepted, true, path);
    if (decision.accepted) {
      assert.ok(
        (HEADLESS_RUNNER_OPERATION_IDS as readonly string[]).includes(
          decision.operationId
        )
      );
    }
  }
});

test("refuses workstation operations such as chats, filesystem and deploy", () => {
  for (const path of [
    "/api/gateway/symphony/chat/session-1",
    "/api/gateway/directories",
    "/api/gateway/terminal-chat",
    "/api/gateway/git/commit-push",
    "/api/gateway/deploy",
    "/api/gateway/update-and-restart",
  ]) {
    const decision = classifyHeadlessCommand(path);
    assert.equal(decision.accepted, false, path);
    if (!decision.accepted) {
      assert.equal(
        decision.reason,
        HeadlessCommandRejection.NotSupported,
        path
      );
    }
  }
});

test("refuses paths outside the gateway and ignores query strings", () => {
  const unknown = classifyHeadlessCommand("/etc/passwd");
  assert.deepEqual(unknown, {
    accepted: false,
    reason: HeadlessCommandRejection.UnknownOperation,
  });
  assert.equal(classifyHeadlessCommand(`${LOOP_PATH}?x=1`).accepted, true);
});

test("points loop callbacks at the runner's API URL", () => {
  const original = command(LOOP_PATH, {
    loopId: "loop-1",
    apiBaseUrl: "http://localhost:3002",
    agentFlowAuthToken: "token",
  });
  const rewritten = rewriteLoopCallbackUrl(original, RUNNER_API_URL);
  assert.deepEqual(rewritten.body, {
    loopId: "loop-1",
    apiBaseUrl: RUNNER_API_URL,
    agentFlowAuthToken: "token",
  });
  assert.equal(
    (original.body as { apiBaseUrl: string }).apiBaseUrl,
    "http://localhost:3002"
  );
});

test("leaves other commands and loop bodies without a callback URL alone", () => {
  const kill = command("/api/gateway/symphony/loop/kill", {
    loopId: "loop-1",
    apiBaseUrl: "http://localhost:3002",
  });
  assert.equal(rewriteLoopCallbackUrl(kill, RUNNER_API_URL), kill);
  const signed = command(LOOP_PATH, { loopId: "loop-1", userIntent: {} });
  assert.equal(rewriteLoopCallbackUrl(signed, RUNNER_API_URL), signed);
});
