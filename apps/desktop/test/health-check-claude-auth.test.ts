import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { CheckSeverity } from "@agentflow-ai/loops-api/compute-target";
import {
  CLAUDE_AUTH_CHECK_ID,
  type ClaudeAuthCheckDeps,
  checkClaudeAuth,
} from "../src/server/operations/health-check-claude-auth.js";

const CONFIG_DIR = path.join("/home", "runner", ".claude");
const MODEL_PROVIDER_RE = /model provider/;

function deps(
  overrides: Partial<ClaudeAuthCheckDeps> = {}
): ClaudeAuthCheckDeps {
  return {
    getEnv: () => Promise.resolve({ CLAUDE_CONFIG_DIR: CONFIG_DIR }),
    fileExists: () => false,
    platform: "linux",
    hasKeychainCredential: () => Promise.resolve(false),
    ...overrides,
  };
}

describe("checkClaudeAuth", () => {
  test("passes with the credential Claude Code would use", async () => {
    const cases: [Record<string, string>, string][] = [
      [
        { ANTHROPIC_AUTH_TOKEN: "sk-1", ANTHROPIC_API_KEY: "k" },
        "ANTHROPIC_AUTH_TOKEN",
      ],
      [{ ANTHROPIC_API_KEY: "k" }, "ANTHROPIC_API_KEY"],
      [{ CLAUDE_CODE_OAUTH_TOKEN: "o" }, "CLAUDE_CODE_OAUTH_TOKEN"],
    ];
    for (const [env, source] of cases) {
      const result = await checkClaudeAuth(
        deps({ getEnv: () => Promise.resolve(env) })
      );
      assert.equal(result.passed, true);
      assert.equal(result.version, source);
    }
  });

  test("finds the /login credentials file and the macOS keychain", async () => {
    const file = await checkClaudeAuth(
      deps({
        fileExists: (filePath) =>
          filePath === path.join(CONFIG_DIR, ".credentials.json"),
      })
    );
    const keychain = await checkClaudeAuth(
      deps({
        platform: "darwin",
        hasKeychainCredential: () => Promise.resolve(true),
      })
    );

    assert.equal(file.version, "credentials file");
    assert.equal(keychain.version, "macOS keychain");
  });

  test("warns without failing the required checks when nothing is configured", async () => {
    const result = await checkClaudeAuth(deps());

    assert.equal(result.id, CLAUDE_AUTH_CHECK_ID);
    assert.equal(result.passed, false);
    assert.equal(result.required, false);
    assert.equal(result.severity, CheckSeverity.Warning);
    assert.match(result.remediation ?? "", MODEL_PROVIDER_RE);
  });
});
