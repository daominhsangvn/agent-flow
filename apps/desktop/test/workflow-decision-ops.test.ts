import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { WORKFLOW_DECISION_GATEWAY_PATH } from "@repo/api/src/types/workflow-decision";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  DECISION_DISALLOWED_TOOLS,
  DECISION_MAX_TURNS,
  DECISION_MCP_CONFIG_FILE,
  DECISIONS_DIR,
  readDecisionAnswer,
  registerWorkflowDecisionRoutes,
  resolveDecisionFolder,
} from "../src/server/operations/workflow-decision.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

/**
 * Workflow decisions on the computer: Claude Code answers one prompt without
 * tools in the decision's own folder, and its final answer goes back to the
 * API as the `result` line of an ndjson stream.
 */

const DECISION_ID = "0199a5f0-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
const PROMPT = "Is this item a PRD? Answer with JSON.";
const ANSWER = JSON.stringify({ type: "prd", reason: "Feature labelled PRD." });
const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: ANSWER,
  total_cost_usd: 0.002,
});
const INIT_LINE = JSON.stringify({ type: "system", subtype: "init" });
const NO_ALLOWED_DIRS_RE = /no allowed directories/;
const AUTH_ERROR_RE = /^Claude Code failed: authentication_error/;
const STDERR_TAIL_RE = /exit code 1\): fatal: model unavailable/;
const TIMEOUT_RE = /did not finish within 5 minutes/;
const INVALID_ID_RE = /^Invalid decision request: decisionId/;
const NO_FOLDER_RE = /^No folder for the decision/;
const NO_CLAUDE_RE = /claude CLI not found in PATH/;

const roots: string[] = [];

afterEach(() => {
  resetShellPathCache();
  _setKnownBinaryLocationsForResolverTest(null);
});

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveDecisionFolder", () => {
  test("is the decision's own folder in the first allowed directory", () => {
    const root = makeRoot();
    assert.equal(
      resolveDecisionFolder(DECISION_ID, [root]),
      path.join(root, DECISIONS_DIR, DECISION_ID)
    );
  });

  test("throws without an allowed directory", () => {
    assert.throws(
      () => resolveDecisionFolder(DECISION_ID, []),
      NO_ALLOWED_DIRS_RE
    );
  });
});

describe("readDecisionAnswer", () => {
  const exit = { code: 0, stderr: "", timedOut: false };

  test("returns the answer with Claude Code's cost", () => {
    assert.deepEqual(readDecisionAnswer(JSON.parse(RESULT_LINE), exit), {
      type: "result",
      ok: true,
      answer: ANSWER,
      costUsd: 0.002,
    });
  });

  test("keeps an unknown cost unknown", () => {
    const answer = readDecisionAnswer({ type: "result", result: ANSWER }, exit);
    assert.equal(answer.ok && answer.costUsd, null);
  });

  test("fails when Claude Code reports an error", () => {
    const answer = readDecisionAnswer(
      { type: "result", is_error: true, result: "authentication_error" },
      exit
    );
    assert.match(answer.ok ? "" : answer.error, AUTH_ERROR_RE);
  });

  test("fails with the end of stderr when there is no result line", () => {
    const answer = readDecisionAnswer(null, {
      code: 1,
      stderr: "fatal: model unavailable\n",
      timedOut: false,
    });
    assert.match(answer.ok ? "" : answer.error, STDERR_TAIL_RE);
  });

  test("fails when the decision ran out of time", () => {
    const answer = readDecisionAnswer(JSON.parse(RESULT_LINE), {
      ...exit,
      timedOut: true,
    });
    assert.match(answer.ok ? "" : answer.error, TIMEOUT_RE);
  });
});

describe("POST workflow decision", () => {
  test("runs Claude Code without tools in the decision's folder and streams its answer", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager(
      [],
      [{ lines: [INIT_LINE, RESULT_LINE], exitCode: 0 }]
    );
    const events = await withFakeClaude(root, () =>
      postDecision(processManager, [root], decisionBody())
    );

    assert.deepEqual(events, [
      { type: "status", status: "running" },
      { type: "result", ok: true, answer: ANSWER, costUsd: 0.002 },
      { type: "done" },
    ]);
    const folder = path.join(root, DECISIONS_DIR, DECISION_ID);
    const mcpConfig = path.join(folder, DECISION_MCP_CONFIG_FILE);
    const [spawn] = processManager.spawns;
    assert.equal(spawn?.cwd, folder);
    assert.equal(spawn?.input, PROMPT);
    assert.deepEqual(spawn?.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "default",
      `--disallowedTools=${DECISION_DISALLOWED_TOOLS}`,
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--max-turns",
      String(DECISION_MAX_TURNS),
    ]);
    for (const tool of ["Bash", "Read", "Write", "WebFetch"]) {
      assert.ok(DECISION_DISALLOWED_TOOLS.split(",").includes(tool), tool);
    }
    assert.deepEqual(JSON.parse(readFileSync(mcpConfig, "utf8")), {
      mcpServers: {},
    });
    assert.equal(readFileSync(path.join(folder, "prompt.md"), "utf8"), PROMPT);
    assert.equal(
      readFileSync(path.join(folder, "claude-output.jsonl"), "utf8"),
      `${INIT_LINE}\n${RESULT_LINE}\n`
    );
    const stored = JSON.parse(
      readFileSync(path.join(folder, "result.json"), "utf8")
    ) as { ok: boolean };
    assert.equal(stored.ok, true);
  });

  test("answers a request it cannot read with a failure", async () => {
    const processManager = new FakeProcessManager();
    const events = await postDecision(processManager, [makeRoot()], {
      ...decisionBody(),
      decisionId: "../../etc",
    });

    assert.match(String(events[1]?.error), INVALID_ID_RE);
    assert.deepEqual(events.at(-1), { type: "done" });
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a computer without allowed directories with a failure", async () => {
    const processManager = new FakeProcessManager();
    const events = await postDecision(processManager, [], decisionBody());

    assert.equal(events[1]?.ok, false);
    assert.match(String(events[1]?.error), NO_FOLDER_RE);
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a computer without Claude Code with a failure", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager();
    const events = await withShellPathEnvForTest({ PATH: "" }, () => {
      _setKnownBinaryLocationsForResolverTest({ claude: [], codex: [] });
      setShellPathForTest();
      return postDecision(processManager, [root], decisionBody());
    });

    assert.equal(events[1]?.ok, false);
    assert.match(String(events[1]?.error), NO_CLAUDE_RE);
    assert.equal(processManager.spawns.length, 0);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-decision-"));
  roots.push(root);
  return root;
}

function decisionBody(): Record<string, unknown> {
  return { decisionId: DECISION_ID, prompt: PROMPT };
}

async function postDecision(
  processManager: FakeProcessManager,
  allowedDirs: string[],
  body: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const dispatcher = new OperationDispatcher();
  registerWorkflowDecisionRoutes(dispatcher, {
    processManager: processManager.asProcessManager(),
    getAllowedDirectories: () => allowedDirs,
    getClaudeShellEnv: async () => ({}),
  });
  const response = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: WORKFLOW_DECISION_GATEWAY_PATH,
    body: JSON.stringify(body),
  });
  if (response.statusCode !== 200) {
    throw new Error(`unexpected status ${response.statusCode}`);
  }
  return response.rawBody
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A `claude` on the login-shell PATH; FakeProcessManager never runs it. */
function withFakeClaude<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return withShellPathEnvForTest({ PATH: bin }, () => {
    _setKnownBinaryLocationsForResolverTest({ claude: [], codex: [] });
    setShellPathForTest();
    return fn();
  });
}
