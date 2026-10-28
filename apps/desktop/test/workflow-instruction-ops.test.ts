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
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { WORKFLOW_INSTRUCTION_GATEWAY_PATH } from "@repo/api/src/types/workflow-instruction";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import type { OpenIntegrationSession } from "../src/server/operations/integration-session-client.js";
import {
  INSTRUCTION_ACTIONS_DIR,
  INSTRUCTION_ALLOWED_TOOLS,
  INSTRUCTION_DISALLOWED_TOOLS,
  INSTRUCTION_MCP_CONFIG_FILE,
  readInstructionAnswer,
  registerWorkflowInstructionRoutes,
  resolveInstructionWorkspace,
} from "../src/server/operations/workflow-instruction.js";
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
 * Instruction actions on the computer: the agent runs read-only in the run's
 * workspace (the folder the run's loops share) and its final answer goes back
 * to the API as the `result` line of an ndjson stream.
 */

const ACTION_RUN_ID = "5b0c2f4e-7a51-4c3e-9d2a-1f6b8e9c0a11";
const REPOSITORY = {
  fullName: "acme/calculator",
  cloneUrl: "https://git.example.com/acme/calculator.git",
};
const PROMPT = "Summarize the plan and propose one comment.";
const ANSWER = JSON.stringify({ operations: [], note: "Nothing to post." });
const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: ANSWER,
  total_cost_usd: 0.12,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
  },
});
const INIT_LINE = JSON.stringify({ type: "system", subtype: "init" });
const NO_ALLOWED_DIRS_RE = /no allowed directories/;
const AUTH_ERROR_RE = /authentication_error/;
const STDERR_TAIL_RE = /exit code 1\): fatal: model unavailable/;
const TIMEOUT_RE = /did not finish within 15/;
const INVALID_PROMPT_RE = /^Invalid instruction request: prompt/;
const NO_WORKSPACE_RE = /^No workspace for the run/;
const NO_CLAUDE_RE = /claude CLI not found in PATH/;
const SESSION_FAILED_RE =
  /^The instruction's integration tools could not be opened: AgentFlow answered 404/;
const NO_API_KEY_RE = /has no AgentFlow API key/;
const TOKEN = "ist_session-token-for-the-agent-0123456789";
const MCP_URL = "http://mcp.test/mcp";
/** Claude Code expands the variable from the agent's environment. */
const TOKEN_HEADER_REFERENCE = [
  "Bearer $",
  "{AGENTFLOW_INTEGRATION_TOKEN}",
].join("");

const openSession: OpenIntegrationSession = (actionRunId) =>
  Promise.resolve({
    token: `${TOKEN}`,
    expiresAt: "2026-10-13T09:00:00.000Z",
    mcpUrl: actionRunId === ACTION_RUN_ID ? MCP_URL : "http://wrong.test",
  });

const roots: string[] = [];
let savedParentDir: string | undefined;

beforeEach(() => {
  savedParentDir = process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
});

afterEach(() => {
  if (savedParentDir === undefined) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  } else {
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = savedParentDir;
  }
  resetShellPathCache();
  _setKnownBinaryLocationsForResolverTest(null);
});

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveInstructionWorkspace", () => {
  test("is the loops' workspace next to the checkouts' host folders", () => {
    const root = makeRoot();
    assert.equal(
      resolveInstructionWorkspace(
        { workspaceKey: "PLN-5", repository: REPOSITORY },
        [root]
      ),
      path.join(root, "loops", "pln-5")
    );
  });

  test("keeps a hostile key inside the loops folder", () => {
    const root = makeRoot();
    const workspace = resolveInstructionWorkspace(
      { workspaceKey: "../../etc", repository: REPOSITORY },
      [root]
    );
    assert.equal(path.dirname(workspace), path.join(root, "loops"));
  });

  test("follows SYMPHONY_WORKTREE_PARENT_DIR like a loop", () => {
    const root = makeRoot();
    const parent = path.join(root, "worktrees");
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = parent;
    assert.equal(
      resolveInstructionWorkspace(
        { workspaceKey: "PLN-5", repository: REPOSITORY },
        [root]
      ),
      path.join(parent, "loops", "pln-5")
    );
  });

  test("throws without an allowed directory", () => {
    assert.throws(
      () =>
        resolveInstructionWorkspace(
          { workspaceKey: "PLN-5", repository: REPOSITORY },
          []
        ),
      NO_ALLOWED_DIRS_RE
    );
  });
});

describe("readInstructionAnswer", () => {
  const exit = { code: 0, stderr: "", timedOut: false };

  test("returns the answer with Claude Code's cost and all input tokens", () => {
    assert.deepEqual(readInstructionAnswer(JSON.parse(RESULT_LINE), exit), {
      type: "result",
      ok: true,
      answer: ANSWER,
      costUsd: 0.12,
      inputTokens: 130,
      outputTokens: 5,
    });
  });

  test("keeps an unknown cost unknown", () => {
    const answer = readInstructionAnswer(
      { type: "result", result: ANSWER },
      exit
    );
    assert.equal(answer.ok, true);
    assert.equal(answer.ok && answer.costUsd, null);
  });

  test("fails, retryably, when the agent reports an error", () => {
    const answer = readInstructionAnswer(
      { type: "result", is_error: true, result: "authentication_error" },
      exit
    );
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.retryable, true);
    assert.match(answer.ok ? "" : answer.error, AUTH_ERROR_RE);
  });

  test("fails with the end of stderr when there is no result line", () => {
    const answer = readInstructionAnswer(null, {
      code: 1,
      stderr: "fatal: model unavailable\n",
      timedOut: false,
    });
    assert.equal(answer.ok, false);
    assert.match(answer.ok ? "" : answer.error, STDERR_TAIL_RE);
  });

  test("fails, retryably, when the agent ran out of time", () => {
    const answer = readInstructionAnswer(JSON.parse(RESULT_LINE), {
      ...exit,
      timedOut: true,
    });
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.retryable, true);
    assert.match(answer.ok ? "" : answer.error, TIMEOUT_RE);
  });
});

describe("POST workflow instruction", () => {
  test("runs the agent read-only in the workspace and streams its answer", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager(
      [],
      [{ lines: [INIT_LINE, RESULT_LINE], exitCode: 0 }]
    );
    const events = await withFakeClaude(root, () =>
      postInstruction(processManager, [root], instructionBody())
    );

    assert.deepEqual(events, [
      { type: "status", status: "running" },
      {
        type: "result",
        ok: true,
        answer: ANSWER,
        costUsd: 0.12,
        inputTokens: 130,
        outputTokens: 5,
      },
      { type: "done" },
    ]);
    const workspace = path.join(root, "loops", "pln-5");
    const [spawn] = processManager.spawns;
    assert.equal(spawn?.cwd, workspace);
    assert.equal(spawn?.input, PROMPT);
    assert.deepEqual(spawn?.args.slice(0, 8), [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "default",
      `--allowedTools=${INSTRUCTION_ALLOWED_TOOLS}`,
      `--disallowedTools=${INSTRUCTION_DISALLOWED_TOOLS}`,
    ]);
    assert.ok(
      !spawn?.args.some((arg) => arg.includes("dangerously")),
      "the agent must not skip permission checks"
    );

    const folder = path.join(workspace, INSTRUCTION_ACTIONS_DIR, ACTION_RUN_ID);
    const mcpConfig = path.join(folder, INSTRUCTION_MCP_CONFIG_FILE);
    assert.deepEqual(spawn?.args.slice(8, 11), [
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
    ]);
    assert.ok(
      INSTRUCTION_ALLOWED_TOOLS.split(",").includes(
        "mcp__agentflow_integrations"
      )
    );
    assert.equal(spawn?.env?.AGENTFLOW_INTEGRATION_TOKEN, TOKEN);
    const config = readFileSync(mcpConfig, "utf8");
    assert.deepEqual(JSON.parse(config), {
      mcpServers: {
        agentflow_integrations: {
          type: "http",
          url: MCP_URL,
          headers: {
            Authorization: TOKEN_HEADER_REFERENCE,
          },
        },
      },
    });
    assert.ok(!config.includes(TOKEN), "the token must stay out of files");
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

  test("answers with a retryable failure when the integration tools cannot be opened", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager();
    const events = await withFakeClaude(root, () =>
      postInstruction(processManager, [root], instructionBody(), () =>
        Promise.reject(new Error("AgentFlow answered 404"))
      )
    );

    const result = events[1] as {
      ok: boolean;
      retryable: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, SESSION_FAILED_RE);
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a computer without an API key with a final failure", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager();
    const events = await withFakeClaude(root, () =>
      postInstruction(processManager, [root], instructionBody(), null)
    );

    const result = events[1] as {
      ok: boolean;
      retryable: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, NO_API_KEY_RE);
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a request it cannot read with a final failure", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager();
    const events = await postInstruction(processManager, [root], {
      ...instructionBody(),
      prompt: "",
    });

    const result = events[1] as {
      ok: boolean;
      retryable: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, INVALID_PROMPT_RE);
    assert.deepEqual(events.at(-1), { type: "done" });
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a computer without allowed directories with a final failure", async () => {
    const processManager = new FakeProcessManager();
    const events = await postInstruction(processManager, [], instructionBody());

    const result = events[1] as {
      ok: boolean;
      retryable: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, NO_WORKSPACE_RE);
    assert.equal(processManager.spawns.length, 0);
  });

  test("answers a computer without Claude Code with a retryable failure", async () => {
    const root = makeRoot();
    const processManager = new FakeProcessManager();
    const events = await withShellPathEnvForTest({ PATH: "" }, () => {
      _setKnownBinaryLocationsForResolverTest({ claude: [], codex: [] });
      setShellPathForTest();
      return postInstruction(processManager, [root], instructionBody());
    });

    const result = events[1] as {
      ok: boolean;
      retryable: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, NO_CLAUDE_RE);
    assert.equal(processManager.spawns.length, 0);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-instruction-"));
  roots.push(root);
  return root;
}

function instructionBody(): Record<string, unknown> {
  return {
    actionRunId: ACTION_RUN_ID,
    workspaceKey: "PLN-5",
    repository: REPOSITORY,
    prompt: PROMPT,
  };
}

async function postInstruction(
  processManager: FakeProcessManager,
  allowedDirs: string[],
  body: Record<string, unknown>,
  opener: OpenIntegrationSession | null = openSession
): Promise<Record<string, unknown>[]> {
  const dispatcher = new OperationDispatcher();
  registerWorkflowInstructionRoutes(dispatcher, {
    processManager: processManager.asProcessManager(),
    getAllowedDirectories: () => allowedDirs,
    getClaudeShellEnv: async () => ({}),
    openIntegrationSession: opener ?? undefined,
  });
  const response = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: WORKFLOW_INSTRUCTION_GATEWAY_PATH,
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
