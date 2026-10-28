import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyncedSession,
  createLoopSessionStream,
  foldStreamLine,
  type LoopSessionContext,
} from "../src/headless/headless-session-stream.js";

const LOOP = "01a135c8-80a3-7341-9015-5edbb94e693d";
const SESSION = "95e66585-e753-453e-b826-04cb558b8341";
const T0 = "2026-10-13T15:01:35.000Z";
const REPO_DIR = "/workspace/loops/pln-2/calculator-app";
const WORK_DIR = "/workspace/loops/pln-2/.agentflow-ai/work";

const CONTEXT: LoopSessionContext = {
  loopId: LOOP,
  name: "EXECUTE PLN-2 · workshop/calculator-app",
  running: false,
  failed: false,
  startedAt: T0,
  updatedAt: "2026-10-13T15:14:28.000Z",
  endedAt: "2026-10-13T15:14:28.000Z",
  repositoryFullName: "workshop/calculator-app",
  worktreePath: REPO_DIR,
  sourceArtifactId: null,
  baseBranch: "main",
  workBranch: "symphony/pln-2",
  runnerName: "runner-1",
  command: "EXECUTE",
};

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  parentToolUseId: string | null = null
): string {
  return JSON.stringify({
    type: "assistant",
    session_id: SESSION,
    parent_tool_use_id: parentToolUseId,
    message: {
      id: `msg-${id}`,
      content: [{ type: "tool_use", id, name, input }],
    },
  });
}

function toolResult(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  });
}

/** An implementation run: the main agent and a subagent edit code and AgentFlow's files. */
function implementationStream(): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    // A new file by a subagent: every line added.
    toolUse(
      "write-license",
      "Write",
      { file_path: `${REPO_DIR}/LICENSE`, content: "MIT License\n\nCopyright" },
      "call-implementer"
    ),
    // An overwrite diffs against what the agent read.
    toolUse("read-readme", "Read", { file_path: `${REPO_DIR}/README.md` }),
    toolResult(
      "read-readme",
      "     1\t# calculator-app\n     2\tA calculator."
    ),
    toolUse("write-readme", "Write", {
      file_path: `${REPO_DIR}/README.md`,
      content: "# calculator-app\nA calculator, MIT licensed.",
    }),
    toolUse("edit-readme", "Edit", {
      file_path: `${REPO_DIR}/README.md`,
      old_string: "MIT licensed.",
      new_string: "MIT licensed.\nSee LICENSE.",
    }),
    // AgentFlow's own work files are not code.
    toolUse("edit-plan", "Edit", {
      file_path: `${WORK_DIR}/plan.json`,
      old_string: '"status": "pending"',
      new_string: '"status": "done"',
    }),
    toolUse("write-log", "Write", {
      file_path: `${WORK_DIR}/log.md`,
      content: "# Log\n\n- done\n",
    }),
    // The same tool use seen twice (a repeated block) counts once.
    toolUse(
      "write-license",
      "Write",
      { file_path: `${REPO_DIR}/LICENSE`, content: "MIT License\n\nCopyright" },
      "call-implementer"
    ),
  ];
}

test("a session reports the code its agents edited, AgentFlow's own files left out", () => {
  const stream = createLoopSessionStream();
  for (const line of implementationStream()) {
    foldStreamLine(stream, line, T0);
  }
  const session = buildSyncedSession(stream, CONTEXT);

  // LICENSE +3; README rewritten +1 -1, then +1 -0 by the edit.
  assert.equal(session.linesAdded, 5);
  assert.equal(session.linesRemoved, 1);
  assert.equal(session.filesChanged, 2);
});

test("a session that edited no code leaves its lines unknown", () => {
  const stream = createLoopSessionStream();
  for (const line of implementationStream().filter(
    (line) => !line.includes(REPO_DIR)
  )) {
    foldStreamLine(stream, line, T0);
  }
  const session = buildSyncedSession(stream, { ...CONTEXT, command: "PLAN" });

  assert.equal("linesAdded" in session, false);
  assert.equal("filesChanged" in session, false);
});

test("the branch diff of a loop that committed rides along; none otherwise", () => {
  const stream = createLoopSessionStream();
  foldStreamLine(stream, implementationStream()[0] ?? "", T0);
  const branchDiffStats = {
    linesAdded: 26,
    linesRemoved: 1,
    filesChanged: 2,
    source: "git",
  };

  assert.deepEqual(
    buildSyncedSession(stream, { ...CONTEXT, branchDiffStats }).branchDiffStats,
    branchDiffStats
  );
  assert.equal(
    "branchDiffStats" in
      buildSyncedSession(stream, { ...CONTEXT, branchDiffStats: null }),
    false
  );
});
