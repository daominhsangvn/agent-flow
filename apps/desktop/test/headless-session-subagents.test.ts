import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyncedSession,
  createLoopSessionStream,
  foldStreamLine,
  type LoopSessionContext,
} from "../src/headless/headless-session-stream.js";

const T0 = "2026-10-14T02:02:53.000Z";

const CONTEXT: LoopSessionContext = {
  loopId: "01a13825-f343-767a-81cd-74e01dd2fd13",
  name: "EXECUTE PLN-4 · workshop/calculator-app",
  running: false,
  failed: false,
  startedAt: T0,
  updatedAt: "2026-10-14T02:52:56.000Z",
  endedAt: "2026-10-14T02:52:56.000Z",
  repositoryFullName: "workshop/calculator-app",
  worktreePath: "/workspace/loops/pln-4/calculator-app",
  sourceArtifactId: null,
  baseBranch: "main",
  workBranch: "symphony/pln-4",
  runnerName: "runner-1",
  command: "EXECUTE",
};

function systemLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "system", ...fields });
}

test("a background shell command is not listed as a subagent", () => {
  const stream = createLoopSessionStream();
  const lines = [
    systemLine({
      subtype: "task_started",
      task_id: "a8f58fa25ff2a749d",
      task_type: "local_agent",
      description: "plan-evaluator",
      subagent_type: "code:plan-evaluator",
    }),
    // Claude Code reports a backgrounded Bash call as a task as well; its
    // description is the command itself.
    systemLine({
      subtype: "task_started",
      task_id: "b2tssfd84",
      task_type: "local_bash",
      description: "cd /workspace/loops/pln-4/calculator-app && npm install",
    }),
    systemLine({
      subtype: "task_notification",
      task_id: "b2tssfd84",
      status: "completed",
    }),
    systemLine({
      subtype: "task_notification",
      task_id: "a8f58fa25ff2a749d",
      status: "completed",
    }),
  ];
  for (const line of lines) {
    foldStreamLine(stream, line, T0);
  }

  const session = buildSyncedSession(stream, CONTEXT);

  assert.deepEqual(
    session.agents.map((agent) => [agent.type, agent.name, agent.status]),
    [
      ["main", "claude", "completed"],
      ["subagent", "plan-evaluator", "completed"],
    ]
  );
});

test("a task without a task type still counts as a subagent", () => {
  const stream = createLoopSessionStream();
  foldStreamLine(
    stream,
    systemLine({
      subtype: "task_started",
      task_id: "task-1",
      description: "plan-importer",
      subagent_type: "code:plan-importer",
    }),
    T0
  );

  const session = buildSyncedSession(stream, CONTEXT);

  assert.deepEqual(
    session.agents.map((agent) => [agent.type, agent.name]),
    [
      ["main", "claude"],
      ["subagent", "plan-importer"],
    ]
  );
});
