import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fatalPreflightProblems,
  type PreflightDeps,
  REQUIRED_TOOLS,
  runHeadlessPreflight,
  toCapabilities,
} from "../src/headless/headless-preflight.js";
import { ClaudeCredentialSource } from "../src/server/claude-credentials.js";

const WORKSPACE = "/workspace";
const GH_WORD_RE = /\bgh\b/;

function fakeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    getSearchPath: () => Promise.resolve("/usr/bin"),
    findExecutable: (name) => Promise.resolve(`/usr/bin/${name}`),
    readVersion: (executable) => Promise.resolve(`${executable} 1.0.0`),
    getPluginsDir: () => "/opt/agentflow-runner/agent-plugins",
    isWritableDirectory: () => true,
    fileExists: () => false,
    env: {},
    ...overrides,
  };
}

test("a complete machine has no fatal problems", async () => {
  const report = await runHeadlessPreflight(WORKSPACE, fakeDeps());
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.missingRecommended, []);
  assert.deepEqual(fatalPreflightProblems(report), []);
});

test("missing required tools, plugins and workspace are fatal", async () => {
  const report = await runHeadlessPreflight(
    WORKSPACE,
    fakeDeps({
      findExecutable: (name) =>
        Promise.resolve(
          name === "jq" || name === "gh" ? null : `/usr/bin/${name}`
        ),
      getPluginsDir: () => null,
      isWritableDirectory: () => false,
    })
  );
  assert.deepEqual(report.missingRequired, ["jq"]);
  assert.deepEqual(report.missingRecommended, ["gh"]);
  const problems = fatalPreflightProblems(report).join("\n");
  for (const expected of ["jq", "AGENTFLOW_PLUGINS_DIR", "workspace"]) {
    assert.ok(problems.includes(expected), expected);
  }
  assert.doesNotMatch(problems, GH_WORD_RE);
});

test("capabilities report detected tools and never advertise command signing", async () => {
  const report = await runHeadlessPreflight(
    WORKSPACE,
    fakeDeps({
      findExecutable: (name) =>
        Promise.resolve(name === "gh" ? null : `/usr/bin/${name}`),
    })
  );
  const capabilities = toCapabilities(report);
  assert.equal(capabilities.tools.claude, true);
  assert.equal(capabilities.tools.gh, false);
  assert.equal(capabilities.tools.codex, false);
  assert.equal(capabilities.versions.claude, "/usr/bin/claude 1.0.0");
  assert.equal(capabilities.commandSigning, false);
  assert.equal(capabilities.toolchains?.dotnet, "/usr/bin/dotnet 1.0.0");
  for (const tool of REQUIRED_TOOLS) {
    assert.ok(report.tools.some((probe) => probe.name === tool));
  }
});

test("Claude credentials follow Claude Code's precedence", async () => {
  const detect = async (env: NodeJS.ProcessEnv, fileExists = false) =>
    (
      await runHeadlessPreflight(
        WORKSPACE,
        fakeDeps({ env, fileExists: () => fileExists })
      )
    ).claudeCredentials;

  assert.equal(await detect({}), ClaudeCredentialSource.None);
  assert.equal(await detect({}, true), ClaudeCredentialSource.CredentialsFile);
  assert.equal(
    await detect({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" }),
    ClaudeCredentialSource.AuthToken
  );
  assert.equal(
    await detect({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k" }),
    ClaudeCredentialSource.ApiKey
  );
  assert.equal(
    await detect({ CLAUDE_CODE_OAUTH_TOKEN: "o" }, true),
    ClaudeCredentialSource.OAuthToken
  );
});

test("toolchains are reported when found and never required", async () => {
  const report = await runHeadlessPreflight(
    WORKSPACE,
    fakeDeps({
      findExecutable: (name) =>
        Promise.resolve(
          ["dotnet", "cargo", "java"].includes(name) ? null : `/usr/bin/${name}`
        ),
    })
  );
  const capabilities = toCapabilities(report);
  assert.deepEqual(fatalPreflightProblems(report), []);
  assert.equal(capabilities.toolchains?.node, "/usr/bin/node 1.0.0");
  assert.equal(capabilities.toolchains?.dotnet, undefined);
  assert.equal(capabilities.toolchains?.cargo, undefined);
});
