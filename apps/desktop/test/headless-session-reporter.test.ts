import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  resolveStreamFile,
  SESSION_REPORT_BACKOFF_MS,
  scanPluginComponents,
  startHeadlessSessionReporter,
  TRANSCRIPT_UPLOAD_INTERVAL_MS,
  worktreeBranch,
} from "../src/headless/headless-session-reporter.js";
import {
  buildSyncedSession,
  createLoopSessionStream,
  foldStreamLine,
} from "../src/headless/headless-session-stream.js";
import type { LocalJob } from "../src/main/jobs/job-store.js";

const TARGET = "01a12707-7360-710b-b9f0-a498a6560081";
const LOOP = "01a1283a-597e-744b-b0b0-1571ce9dbbb8";
const SESSION = "95e66585-e753-453e-b826-04cb558b8341";
const T0 = "2026-10-11T00:00:00.000Z";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A loop's stream as the Claude Code CLI writes it (stream-json). */
function streamLines(): string[] {
  const assistant = (id: string, output: number, content: unknown[]) =>
    JSON.stringify({
      type: "assistant",
      session_id: SESSION,
      timestamp: "2026-10-11T00:00:05.000Z",
      parent_tool_use_id: null,
      message: {
        id,
        model: "deepseek-flash",
        content,
        usage: {
          input_tokens: 1000,
          output_tokens: output,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
        },
      },
    });
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: SESSION,
      cwd: "/workspace/loops/stp-1",
      model: "deepseek-flash[1m]",
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-11T00:00:01.000Z",
      message: {
        content:
          "<command-message>speckit.specify</command-message>\n<command-name>/speckit.specify</command-name>",
      },
    }),
    // A message is repeated on every content block; its usage counts once.
    assistant("msg_1", 0, [{ type: "thinking", thinking: "..." }]),
    assistant("msg_1", 40, [
      {
        type: "tool_use",
        id: "call_agent",
        name: "Agent",
        input: { subagent_type: "code:plan-importer", description: "import" },
      },
    ]),
    JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "plan-importer",
      subagent_type: "code:plan-importer",
    }),
    assistant("msg_2", 10, [
      {
        type: "tool_use",
        id: "call_skill",
        name: "Skill",
        input: { skill: "code:plan-validate" },
      },
    ]),
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-11T00:00:07.000Z",
      message: {
        content: [
          // A tool result quoting the tag is not an invocation.
          {
            type: "tool_result",
            tool_use_id: "call_skill",
            is_error: true,
            content: "<command-name>/not-a-call</command-name>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
    }),
    "not json",
  ];
}

test("folds a loop stream into an agent session", () => {
  const stream = createLoopSessionStream();
  for (const line of streamLines()) {
    foldStreamLine(stream, line, T0);
  }
  const session = buildSyncedSession(stream, {
    loopId: LOOP,
    name: "STEP PRD-3 · agentflow/color-picker",
    running: true,
    failed: false,
    startedAt: T0,
    updatedAt: "2026-10-11T00:00:03.000Z",
    endedAt: null,
    repositoryFullName: "agentflow/color-picker",
    worktreePath: "/workspace/loops/stp-1/color-picker",
    sourceArtifactId: null,
    baseBranch: "main",
    workBranch: null,
    runnerName: "runner-1",
    command: "STEP",
  });

  // Keyed by the loop; the Claude session is metadata.
  assert.equal(session.externalSessionId, LOOP);
  assert.deepEqual(session.metadata?.harnessSessionIds, [SESSION]);
  assert.equal(session.status, "active");
  assert.equal(session.model, "deepseek-flash[1m]");
  assert.equal(session.cwd, "/workspace/loops/stp-1");
  assert.equal(session.updatedAt, "2026-10-11T00:00:07.000Z");
  assert.equal(session.endedAt, null);
  assert.equal(session.attribution?.sourceLoopId, LOOP);
  assert.deepEqual(session.tokenUsageByModel, [
    {
      model: "deepseek-flash",
      inputTokens: 2000,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    },
  ]);
  assert.deepEqual(
    session.events.map((event) => event.toolName),
    ["Agent", "Skill"]
  );
  assert.deepEqual(
    session.agents.map((agent) => [
      agent.type,
      agent.subagentType,
      agent.status,
    ]),
    [
      ["main", null, "running"],
      ["subagent", "code:plan-importer", "completed"],
    ]
  );
  assert.deepEqual(
    session.components?.map((usage) => [
      usage.componentKind,
      usage.componentKey,
      usage.invocations,
      usage.errorCount,
    ]),
    [
      [AgentComponentKind.Command, "/speckit.specify", 1, 0],
      [AgentComponentKind.Subagent, "code:plan-importer", 1, 0],
      [AgentComponentKind.Skill, "code:plan-validate", 1, 1],
    ]
  );
  assert.equal(session.sessionAnalytics?.toolInvocations, 2);
  assert.equal(session.sessionAnalytics?.errorEvents, 1);
});

test("a finished session reports the result's totals per model, its cost only when priced", () => {
  const stream = createLoopSessionStream();
  for (const line of streamLines()) {
    foldStreamLine(stream, line, T0);
  }
  const result = (costBasis: string) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 16.67,
      modelUsage: {
        "deepseek-flash[1m]": {
          inputTokens: 567_869,
          outputTokens: 393_469,
          cacheReadInputTokens: 7_996_032,
          cacheCreationInputTokens: 0,
          costUSD: 16.67,
          costBasis,
        },
      },
    });
  foldStreamLine(stream, result("unknown"), T0);
  const context = {
    loopId: LOOP,
    name: "EXECUTE PLN-2",
    running: false,
    failed: false,
    startedAt: T0,
    updatedAt: "2026-10-11T00:26:29.285Z",
    endedAt: "2026-10-11T00:26:29.285Z",
    repositoryFullName: null,
    worktreePath: null,
    sourceArtifactId: null,
    baseBranch: null,
    workBranch: null,
    runnerName: "runner-1",
    command: "EXECUTE",
  };
  const unpriced = buildSyncedSession(stream, context);
  assert.deepEqual(unpriced.tokenUsageByModel, [
    {
      model: "deepseek-flash[1m]",
      inputTokens: 567_869,
      outputTokens: 393_469,
      cacheReadTokens: 7_996_032,
      cacheWriteTokens: 0,
    },
  ]);
  assert.equal(unpriced.sessionAnalytics?.outputTokens, 393_469);
  assert.equal(unpriced.sessionAnalytics?.estimatedCostUsd, undefined);

  const priced = createLoopSessionStream();
  for (const line of streamLines()) {
    foldStreamLine(priced, line, T0);
  }
  foldStreamLine(priced, result("list_price"), T0);
  assert.equal(
    buildSyncedSession(priced, context).sessionAnalytics?.estimatedCostUsd,
    16.67
  );
});

test("a loop that retries in fresh Claude sessions is one session with summed totals", () => {
  const stream = createLoopSessionStream();
  const iteration = (sessionId: string, messageId: string, output: number) => [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: "/w",
      model: "m",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: messageId,
        model: "m",
        usage: { input_tokens: 10, output_tokens: 0 },
        content: [],
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      modelUsage: {
        m: {
          inputTokens: 100,
          outputTokens: output,
          costUSD: 1,
          costBasis: "list_price",
        },
      },
    }),
  ];
  for (const line of [
    ...iteration("s-1", "m-1", 7),
    ...iteration("s-2", "m-2", 5),
  ]) {
    foldStreamLine(stream, line, T0);
  }
  // The third session is still running: its assistant usage stands in.
  for (const line of iteration("s-3", "m-3", 9).slice(0, 2)) {
    foldStreamLine(stream, line, T0);
  }
  const session = buildSyncedSession(stream, {
    loopId: LOOP,
    name: "EXECUTE PLN-2",
    running: true,
    failed: false,
    startedAt: T0,
    updatedAt: T0,
    endedAt: null,
    repositoryFullName: "agentflow/calc",
    worktreePath: "/w",
    sourceArtifactId: null,
    baseBranch: "main",
    workBranch: "symphony/execute-pln-2",
    runnerName: "runner-1",
    command: "EXECUTE",
  });
  assert.equal(session.externalSessionId, LOOP);
  assert.deepEqual(session.metadata?.harnessSessionIds, ["s-1", "s-2", "s-3"]);
  assert.deepEqual(session.tokenUsageByModel, [
    {
      model: "m",
      inputTokens: 210,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 2,
    },
  ]);
  assert.equal(session.sessionAnalytics?.estimatedCostUsd, 2);
  assert.equal(session.branch, "symphony/execute-pln-2");
  assert.equal(session.autonomy, 100);
  assert.equal(session.steeringEpisodes, 0);
  assert.deepEqual(session.artifactRefs, [
    {
      kind: "branch",
      repositoryFullName: "agentflow/calc",
      branchName: "symphony/execute-pln-2",
      method: "git_commit",
      relation: "created",
      branchParticipation: "wrote",
      observedAt: T0,
    },
  ]);
});

test("a session's cumulative results count once: the latest replaces the earlier", () => {
  const stream = createLoopSessionStream();
  const result = (modelUsage: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      session_id: "s-1",
      is_error: false,
      modelUsage,
    });
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    // The main agent stops while a background subagent still runs ...
    result({
      m: { inputTokens: 100, outputTokens: 7, costUSD: 1, costBasis: "list" },
    }),
    // ... and stops again, with the session's totals so far, once it reports.
    result({
      m: { inputTokens: 150, outputTokens: 9, costUSD: 1.5, costBasis: "list" },
      h: { inputTokens: 20, outputTokens: 2, costUSD: 0.25, costBasis: "list" },
    }),
  ];
  for (const line of lines) {
    foldStreamLine(stream, line, T0);
  }
  const session = buildSyncedSession(stream, {
    loopId: LOOP,
    name: "EXECUTE PLN-2",
    running: false,
    failed: false,
    startedAt: T0,
    updatedAt: T0,
    endedAt: T0,
    repositoryFullName: null,
    worktreePath: null,
    sourceArtifactId: null,
    baseBranch: null,
    workBranch: null,
    runnerName: "runner-1",
    command: "EXECUTE",
  });
  assert.deepEqual(session.tokenUsageByModel, [
    {
      model: "m",
      inputTokens: 150,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 1.5,
    },
    {
      model: "h",
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.25,
    },
  ]);
  assert.equal(session.sessionAnalytics?.inputTokens, 170);
  assert.equal(session.sessionAnalytics?.estimatedCostUsd, 1.75);
});

test("the work branch is read from a linked worktree's HEAD", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
  const gitDir = path.join(root, "repo", ".git", "worktrees", "loop");
  const worktree = path.join(root, "loop");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(
    path.join(gitDir, "HEAD"),
    "ref: refs/heads/symphony/plan-pln-4\n"
  );
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  assert.equal(worktreeBranch(worktree), "symphony/plan-pln-4");
  fs.writeFileSync(path.join(gitDir, "HEAD"), "0123456789abcdef\n");
  assert.equal(worktreeBranch(worktree), null);
  assert.equal(worktreeBranch(path.join(root, "gone")), null);
  assert.equal(worktreeBranch(undefined), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a finished loop is an inactive or error session with its subagents ended", () => {
  const stream = createLoopSessionStream();
  for (const line of streamLines().slice(0, 5)) {
    foldStreamLine(stream, line, T0);
  }
  const context = {
    loopId: LOOP,
    name: "EXECUTE PLN-2",
    running: false,
    failed: true,
    startedAt: T0,
    updatedAt: "2026-10-11T00:10:00.000Z",
    endedAt: "2026-10-11T00:10:00.000Z",
    repositoryFullName: null,
    worktreePath: null,
    sourceArtifactId: null,
    baseBranch: null,
    workBranch: null,
    runnerName: "runner-1",
    command: "EXECUTE",
  };
  const failed = buildSyncedSession(stream, context);
  assert.equal(failed.status, "error");
  assert.equal(failed.endsWithError, true);
  assert.equal(failed.endedAt, "2026-10-11T00:10:00.000Z");
  assert.deepEqual(
    failed.agents.map((agent) => agent.status),
    ["failed", "failed"]
  );
  const done = buildSyncedSession(stream, { ...context, failed: false });
  assert.equal(done.status, "inactive");
});

test("inventories the bundled plugins' subagents, commands and skills", () => {
  const dir = makePlugin();
  const components = scanPluginComponents([dir]);
  assert.deepEqual(
    components.map((component) => [
      component.componentKind,
      component.componentKey,
    ]),
    [
      [AgentComponentKind.Plugin, "code"],
      [AgentComponentKind.Subagent, "code:plan-importer"],
      [AgentComponentKind.Command, "/code:code"],
      [AgentComponentKind.Skill, "code:plan-validate"],
    ]
  );
  const subagent = components[1];
  assert.equal(subagent?.description, "Imports a plan");
  assert.equal(subagent?.version, "1.17.0");
  assert.match(subagent?.contentHash ?? "", SHA256_HEX_RE);
});

test("reports a loop while it runs and once more when it ends, with its key", async () => {
  const job = makeJob();
  const requests: {
    url: string;
    body: Record<string, unknown>;
    auth: string | null;
  }[] = [];
  const reporter = startHeadlessSessionReporter({
    apiUrl: "http://host.docker.internal:3002",
    apiKey: "sk_live_test",
    runnerName: "runner-1",
    jobStore: {
      listRunning: () => (job.status === "RUNNING" ? [job] : []),
      listCompleted: () => (job.status === "RUNNING" ? [] : [job]),
    },
    getComputeTargetId: () => TARGET,
    getPluginDirs: () => [makePlugin()],
    intervalMs: 3_600_000,
    // Within the finished-loop report window of the job's completedAt.
    now: () => new Date("2026-10-11T00:30:00.000Z"),
    fetchImpl: (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(new Response('{"success":true}', { status: 200 }));
    },
  });
  try {
    await reporter.tick();
    const routes = requests.map((request) => new URL(request.url).pathname);
    assert.deepEqual(routes, [
      "/desktop/components/sync",
      "/desktop/agent-sessions/sync",
    ]);
    assert.ok(
      requests.every(
        (request) =>
          request.auth === "Bearer sk_live_test" &&
          new URL(request.url).searchParams.get("computeTargetId") === TARGET
      )
    );
    const live = sessionOf(requests[1]?.body);
    assert.equal(live.status, "active");
    assert.equal(live.name, "PLAN PLN-2 · agentflow/bookshelf-api");

    // Nothing new: nothing sent.
    await reporter.tick();
    assert.equal(requests.length, 2);

    job.status = "COMPLETED";
    job.completedAt = "2026-10-11T00:20:00.000Z";
    await reporter.tick();
    assert.equal(requests.length, 3);
    assert.equal(sessionOf(requests[2]?.body).status, "inactive");

    // A finished loop is reported once.
    await reporter.tick();
    assert.equal(requests.length, 3);
  } finally {
    reporter.stop();
  }
});

test("archives the loop's transcripts while it runs, then in full once it ends", async () => {
  const job = makeJob();
  let clock = Date.parse(T0);
  const archived: { loop: unknown; at: number }[] = [];
  let archiveOk = false;
  const reporter = startHeadlessSessionReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    runnerName: "runner-1",
    jobStore: {
      listRunning: () => (job.status === "RUNNING" ? [job] : []),
      listCompleted: () => (job.status === "RUNNING" ? [] : [job]),
    },
    getComputeTargetId: () => TARGET,
    getPluginDirs: () => [],
    intervalMs: 3_600_000,
    now: () => new Date(clock),
    uploadTranscripts: (computeTargetId, loop) => {
      assert.equal(computeTargetId, TARGET);
      archived.push({ loop, at: clock });
      return Promise.resolve(archiveOk);
    },
    fetchImpl: () =>
      Promise.resolve(new Response('{"success":true}', { status: 200 })),
  });
  try {
    await reporter.tick();
    assert.deepEqual(
      archived.map((entry) => entry.loop),
      [{ externalSessionId: LOOP, harnessSessionIds: [SESSION] }]
    );
    // Running: not again before the interval.
    fs.appendFileSync(
      job.jsonlPath ?? "",
      `${JSON.stringify({ type: "user" })}\n`
    );
    clock += 60_000;
    await reporter.tick();
    assert.equal(archived.length, 1);

    // Ended: archived in full right away; a failure retries after the interval.
    job.status = "COMPLETED";
    job.completedAt = new Date(clock).toISOString();
    await reporter.tick();
    assert.equal(archived.length, 2);
    await reporter.tick();
    assert.equal(archived.length, 2);
    clock += TRANSCRIPT_UPLOAD_INTERVAL_MS;
    archiveOk = true;
    await reporter.tick();
    assert.equal(archived.length, 3);
    clock += TRANSCRIPT_UPLOAD_INTERVAL_MS;
    await reporter.tick();
    assert.equal(archived.length, 3);
  } finally {
    reporter.stop();
  }
});

test("a finished loop ignores a live stream the next loop of its work directory wrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-step-"));
  const live = path.join(dir, "claude-output.jsonl");
  fs.writeFileSync(live, "next step\n");
  const writtenAt = new Date("2026-10-11T01:22:00.000Z");
  fs.utimesSync(live, writtenAt, writtenAt);
  const job = {
    ...makeJob(),
    jsonlPath: live,
    status: "COMPLETED",
    startedAt: "2026-10-11T01:11:17.000Z",
    completedAt: "2026-10-11T01:12:07.000Z",
  } as LocalJob;
  assert.equal(resolveStreamFile(job), null);
  // Its own stream: written up to (or just after) the loop's end.
  assert.equal(
    resolveStreamFile({ ...job, completedAt: "2026-10-11T01:21:59.000Z" }),
    live
  );
  // A running loop always reads the live stream.
  assert.equal(resolveStreamFile({ ...job, status: "RUNNING" }), live);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a finished loop never takes the archive of a run that started after it ended", () => {
  // PLAN stopped for questions without an archive of its own; the resumed
  // PLAN started 18 s after it ended and left one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-resumed-"));
  const live = path.join(dir, "claude-output.jsonl");
  fs.writeFileSync(
    path.join(dir, "claude-output-20261011-053851-.jsonl"),
    "second plan\n"
  );
  const first = {
    ...makeJob(),
    jsonlPath: live,
    status: "COMPLETED",
    startedAt: "2026-10-11T05:22:34.000Z",
    completedAt: "2026-10-11T05:38:33.000Z",
  } as LocalJob;
  assert.equal(resolveStreamFile(first), null);
  const second = {
    ...first,
    startedAt: "2026-10-11T05:38:51.000Z",
    completedAt: "2026-10-11T05:51:20.000Z",
  };
  assert.equal(
    resolveStreamFile(second),
    path.join(dir, "claude-output-20261011-053851-.jsonl")
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a finished loop keeps its own stream when the next loop starts at once", () => {
  // PLAN ends, run-loop.sh renames its stream, EXECUTE starts seconds later in
  // the same work directory with a new claude-output.jsonl.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-handoff-"));
  const live = path.join(dir, "claude-output.jsonl");
  fs.writeFileSync(live, "plan\n");
  const planIno = fs.statSync(live).ino;
  const archive = path.join(dir, "claude-output-20261011-061449-.jsonl");
  fs.renameSync(live, archive);
  fs.writeFileSync(live, "execute\n");
  const plan = {
    ...makeJob(),
    jsonlPath: live,
    status: "COMPLETED",
    startedAt: "2026-10-11T06:14:49.000Z",
    completedAt: new Date().toISOString(),
  } as LocalJob;
  // Read while it ran: follow the inode to the archive, not the new live file.
  assert.equal(resolveStreamFile(plan, planIno), archive);
  // Never read (the runner restarted): the archive of its run.
  assert.equal(resolveStreamFile(plan), archive);
  // A STEP loop's stream replaced by the next STEP loop: nothing of its own left.
  fs.rmSync(archive);
  assert.equal(resolveStreamFile(plan, planIno), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a finished loop reads the archive the harness renamed its stream to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-archive-"));
  const live = path.join(dir, "claude-output.jsonl");
  // PLAN and EXECUTE share the work directory; each leaves its own archive.
  fs.writeFileSync(
    path.join(dir, "claude-output-20261010-235120-.jsonl"),
    "plan\n"
  );
  fs.writeFileSync(
    path.join(dir, "claude-output-20261011-000250-a1b2.jsonl"),
    "exec\n"
  );
  fs.writeFileSync(path.join(dir, "claude-output.name.txt"), "x\n");
  const job = (startedAt: string, completedAt: string): LocalJob => ({
    ...makeJob(),
    jsonlPath: live,
    status: "COMPLETED",
    startedAt,
    completedAt,
  });

  assert.equal(
    resolveStreamFile(
      job("2026-10-10T23:51:20.017Z", "2026-10-11T00:02:45.225Z")
    ),
    path.join(dir, "claude-output-20261010-235120-.jsonl")
  );
  assert.equal(
    resolveStreamFile(
      job("2026-10-11T00:02:50.710Z", "2026-10-11T00:26:29.285Z")
    ),
    path.join(dir, "claude-output-20261011-000250-a1b2.jsonl")
  );
  // No archive near the loop: nothing to read.
  assert.equal(
    resolveStreamFile(
      job("2026-10-12T08:00:00.000Z", "2026-10-12T08:10:00.000Z")
    ),
    null
  );
  // The live file wins while the loop runs.
  fs.writeFileSync(live, "running\n");
  assert.equal(
    resolveStreamFile({
      ...job("2026-10-11T00:02:50.710Z", "2026-10-11T00:26:29.285Z"),
      status: "RUNNING",
    }),
    live
  );
});

test("pauses after AgentFlow refuses the sessions (e.g. the org disallows sync)", async () => {
  let now = Date.parse(T0);
  let calls = 0;
  const reporter = startHeadlessSessionReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    runnerName: "runner-1",
    jobStore: { listRunning: () => [makeJob()], listCompleted: () => [] },
    getComputeTargetId: () => TARGET,
    getPluginDirs: () => [],
    intervalMs: 3_600_000,
    now: () => new Date(now),
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    },
  });
  try {
    await reporter.tick();
    assert.equal(calls, 1);
    await reporter.tick();
    assert.equal(calls, 1);
    now += SESSION_REPORT_BACKOFF_MS + 1;
    await reporter.tick();
    assert.equal(calls, 2);
  } finally {
    reporter.stop();
  }
});

test("reports a loop only once its stream names the Claude session", async () => {
  const job = makeJob();
  fs.writeFileSync(job.jsonlPath ?? "", "");
  const routes: string[] = [];
  const reporter = startHeadlessSessionReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    runnerName: "runner-1",
    jobStore: { listRunning: () => [job], listCompleted: () => [] },
    getComputeTargetId: () => TARGET,
    getPluginDirs: () => [],
    intervalMs: 3_600_000,
    fetchImpl: (input) => {
      routes.push(new URL(String(input)).pathname);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  try {
    await reporter.tick();
    assert.deepEqual(routes, []);
    fs.writeFileSync(job.jsonlPath ?? "", `${streamLines().join("\n")}\n`);
    await reporter.tick();
    assert.deepEqual(routes, ["/desktop/agent-sessions/sync"]);
  } finally {
    reporter.stop();
  }
});

test("reports nothing while the runner is offline", async () => {
  let calls = 0;
  const reporter = startHeadlessSessionReporter({
    apiUrl: "http://api.test",
    apiKey: "sk_live_test",
    runnerName: "runner-1",
    jobStore: { listRunning: () => [makeJob()], listCompleted: () => [] },
    getComputeTargetId: () => null,
    getPluginDirs: () => [makePlugin()],
    intervalMs: 3_600_000,
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  try {
    await reporter.tick();
    assert.equal(calls, 0);
  } finally {
    reporter.stop();
  }
});

/** The one session of a sync request body. */
function sessionOf(
  body: Record<string, unknown> | undefined
): Record<string, unknown> {
  const sessions = (body?.sessions ?? []) as Record<string, unknown>[];
  return sessions.length === 1 && body?.sessionCount === 1
    ? (sessions[0] ?? {})
    : {};
}

function makeJob(): LocalJob {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-reporter-"));
  const jsonlPath = path.join(dir, "claude-output.jsonl");
  fs.writeFileSync(jsonlPath, `${streamLines().join("\n")}\n`);
  return {
    id: "job-1",
    kind: "SYMPHONY_LOOP",
    loopId: LOOP,
    command: "PLAN",
    artifactSlug: "PLN-2",
    primaryRepoFullName: "agentflow/bookshelf-api",
    worktreeDir: path.join(dir, "bookshelf-api"),
    claudeWorkDir: dir,
    jsonlPath,
    status: "RUNNING",
    startedAt: T0,
    updatedAt: "2026-10-11T00:00:03.000Z",
  };
}

function makePlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-code-"));
  const write = (relative: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  write(
    ".claude-plugin/plugin.json",
    JSON.stringify({ name: "code", version: "1.17.0", description: "Code" })
  );
  write(
    "agents/plan-importer.md",
    "---\nname: plan-importer\ndescription: Imports a plan\n---\nBody"
  );
  write("commands/code.md", "---\ndescription: Run the code loop\n---\nBody");
  write(
    "skills/plan-validate/SKILL.md",
    "---\nname: plan-validate\ndescription: Validates a plan\n---\nBody"
  );
  return dir;
}
