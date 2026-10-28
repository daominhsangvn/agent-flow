import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { ClaudeCodeVersionChannel } from "@repo/api/src/types/compute-target-model-provider";
import {
  parseSymphonyLoopRequestBody,
  SymphonyLoopRequestValidationError,
} from "../src/server/operations/symphony-loop-request.js";

const BASE_BODY = {
  loopId: "aaaaaaaa-0000-0000-0000-000000000002",
  command: LoopCommand.Plan,
  agentFlowAuthToken: "token",
  artifacts: [],
};

describe("parseSymphonyLoopRequestBody claudeEnv", () => {
  test("keeps the computer's model provider variables", () => {
    const claudeEnv = {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
      ANTHROPIC_MODEL: "deepseek-chat",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-chat",
      DISABLE_TELEMETRY: "1",
    };

    const parsed = parseSymphonyLoopRequestBody({ ...BASE_BODY, claudeEnv });

    assert.deepEqual(parsed.claudeEnv, claudeEnv);
  });

  test("omits claudeEnv when the dispatcher sends none", () => {
    const parsed = parseSymphonyLoopRequestBody({ ...BASE_BODY });

    assert.equal("claudeEnv" in parsed, false);
  });

  test("refuses variables that are not Claude Code settings", () => {
    for (const key of [
      "PATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "anthropic_model",
    ]) {
      assert.throws(
        () =>
          parseSymphonyLoopRequestBody({
            ...BASE_BODY,
            claudeEnv: { [key]: "x" },
          }),
        SymphonyLoopRequestValidationError,
        key
      );
    }
  });
});

describe("parseSymphonyLoopRequestBody claudeCodeVersion", () => {
  test("keeps latest or an exact release", () => {
    for (const claudeCodeVersion of [
      ClaudeCodeVersionChannel.Latest,
      "2.1.290",
    ]) {
      const parsed = parseSymphonyLoopRequestBody({
        ...BASE_BODY,
        claudeCodeVersion,
      });

      assert.equal(parsed.claudeCodeVersion, claudeCodeVersion);
    }
  });

  test("omits it when the dispatcher sends none", () => {
    const parsed = parseSymphonyLoopRequestBody({ ...BASE_BODY });

    assert.equal("claudeCodeVersion" in parsed, false);
  });

  test("refuses values that are not an installer target or a file name", () => {
    for (const claudeCodeVersion of [
      "",
      "../../bin/sh",
      "2.1.290 --force",
      "2.1.290; curl evil",
      42,
    ]) {
      assert.throws(
        () => parseSymphonyLoopRequestBody({ ...BASE_BODY, claudeCodeVersion }),
        SymphonyLoopRequestValidationError,
        String(claudeCodeVersion)
      );
    }
  });
});
