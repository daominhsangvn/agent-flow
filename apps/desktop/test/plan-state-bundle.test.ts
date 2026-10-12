import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import {
  buildPlanStateManifest,
  collectPlanStateFiles,
  decodePlanStateBundle,
  encodePlanStateBundle,
  extractPlanStateBundle,
  isLocalPlanStateCurrent,
  PLAN_STATE_FILE,
  PlanLoopOutcome,
  PlanNextStep,
  PlanPhase,
  type PlanStateManifest,
  readPlanStateManifest,
} from "../src/server/operations/plan-state-bundle.js";

let root: string;
let workDir: string;

function write(relPath: string, content: string): void {
  const file = path.join(workDir, ...relPath.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function plan(fields: Record<string, unknown[]>): void {
  write("plan.json", JSON.stringify({ content: "# Plan", ...fields }));
}

function manifest(
  overrides: Partial<PlanStateManifest> = {}
): PlanStateManifest {
  return {
    schemaVersion: 1,
    loopId: "loop-1",
    command: LoopCommand.Plan,
    outcome: PlanLoopOutcome.Succeeded,
    savedAt: "2026-10-11T00:00:00.000Z",
    baseCommit: null,
    phase: PlanPhase.Planned,
    nextStep: PlanNextStep.Execute,
    progress: {
      tasksTotal: 0,
      tasksDone: 0,
      openQuestions: 0,
      answeredQuestions: 0,
    },
    history: [],
    skipped: [],
    ...overrides,
  };
}

/** False where the OS refuses file symlinks (Windows without the privilege). */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

function rawBundle(files: { path: string; data: string }[]): Buffer {
  return gzipSync(
    JSON.stringify({ schemaVersion: 1, manifest: manifest(), files })
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
  workDir = path.join(root, "work");
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plan-state files", () => {
  test("the plan, its exploration and reviews are state; runtime output and secrets are not", async () => {
    for (const relPath of [
      "plan.json",
      "plan.md",
      "prd.md",
      "state.json",
      "investigation-log.md",
      "code-map-web.json",
      ".plan-base",
      "reviews/security.review.json",
      ".agentflow-ai/imported-plan",
      // not state:
      "claude-output-20261011-081400-.jsonl",
      "symphony-loop.log",
      "runs.log",
      "perf.jsonl",
      "process.pid",
      "session-id.txt",
      "claude-output.name.txt",
      "prompt.md",
      "plan-prompt.txt",
      ".agentflow-ai/config.env",
      ".agentflow-ai/native-iteration.last",
      ".learnings/pending/x.json",
      ".tool-calls/1.json",
      ".env",
      ".env.local",
      "deploy.pem",
      "id_rsa",
      ".npmrc",
      PLAN_STATE_FILE,
    ]) {
      write(relPath, relPath);
    }
    const outside = path.join(root, "secret.txt");
    writeFileSync(outside, "do not bundle");
    const linked = trySymlink(outside, path.join(workDir, "notes.md"));

    const { files, skipped } = await collectPlanStateFiles(workDir);
    assert.deepEqual(
      files.map((file) => file.path),
      [
        ".agentflow-ai/imported-plan",
        ".plan-base",
        "code-map-web.json",
        "investigation-log.md",
        "plan.json",
        "plan.md",
        "prd.md",
        "reviews/security.review.json",
        "state.json",
      ]
    );
    assert.deepEqual(skipped, []);
    assert.equal(
      files.find((file) => file.path === "plan.json")?.data.toString(),
      "plan.json"
    );
    if (linked) {
      assert.ok(!files.some((file) => file.path === "notes.md"));
    }
  });
});

describe("plan-state manifest", () => {
  test("a PLAN stopped on questions waits for the answers", async () => {
    plan({
      pendingTasks: [{ id: "T-1.1" }, { id: "T-1.2" }],
      completedTasks: [],
      openQuestions: [{ id: "Q-001" }],
      answeredQuestions: [{ id: "Q-002" }],
    });
    write(".plan-base", "abc123\n");
    const result = await buildPlanStateManifest({
      workDir,
      loopId: "loop-plan",
      command: LoopCommand.Plan,
      outcome: PlanLoopOutcome.Succeeded,
      savedAt: "2026-10-11T08:00:00.000Z",
      skipped: [],
    });
    assert.equal(result.phase, PlanPhase.AwaitingAnswers);
    assert.equal(result.nextStep, PlanNextStep.AnswerQuestions);
    assert.deepEqual(result.progress, {
      tasksTotal: 2,
      tasksDone: 0,
      openQuestions: 1,
      answeredQuestions: 1,
    });
    assert.equal(result.baseCommit, "abc123");
    assert.deepEqual(
      result.history.map((entry) => entry.loopId),
      ["loop-plan"]
    );
  });

  test("an EXECUTE continues the history it was restored with", async () => {
    write(
      PLAN_STATE_FILE,
      JSON.stringify(
        manifest({
          loopId: "loop-plan",
          history: [
            {
              loopId: "loop-plan",
              command: LoopCommand.Plan,
              outcome: PlanLoopOutcome.Succeeded,
              savedAt: "2026-10-11T08:00:00.000Z",
              phase: PlanPhase.Planned,
            },
          ],
        })
      )
    );
    plan({
      pendingTasks: [{ id: "T-1.2" }],
      completedTasks: [{ id: "T-1.1" }],
    });
    const partial = await buildPlanStateManifest({
      workDir,
      loopId: "loop-exec",
      command: LoopCommand.Execute,
      outcome: PlanLoopOutcome.Failed,
      savedAt: "2026-10-11T09:00:00.000Z",
      skipped: [],
    });
    assert.equal(partial.phase, PlanPhase.Implementing);
    assert.equal(partial.nextStep, PlanNextStep.ContinueExecution);
    assert.deepEqual(
      partial.history.map((entry) => `${entry.command}:${entry.outcome}`),
      ["PLAN:succeeded", "EXECUTE:failed"]
    );

    // The same loop saving again (a finalization retry) is recorded once.
    writeFileSync(path.join(workDir, PLAN_STATE_FILE), JSON.stringify(partial));
    plan({
      pendingTasks: [],
      completedTasks: [{ id: "T-1.1" }, { id: "T-1.2" }],
    });
    const done = await buildPlanStateManifest({
      workDir,
      loopId: "loop-exec",
      command: LoopCommand.Execute,
      outcome: PlanLoopOutcome.Succeeded,
      savedAt: "2026-10-11T09:30:00.000Z",
      skipped: [],
    });
    assert.equal(done.phase, PlanPhase.Implemented);
    assert.equal(done.nextStep, PlanNextStep.Review);
    assert.deepEqual(
      done.history.map((entry) => `${entry.loopId}:${entry.phase}`),
      ["loop-plan:planned", "loop-exec:implemented"]
    );
  });

  test("without a plan the next step is planning", async () => {
    const result = await buildPlanStateManifest({
      workDir,
      loopId: "loop-plan",
      command: LoopCommand.Plan,
      outcome: PlanLoopOutcome.Failed,
      savedAt: "2026-10-11T08:00:00.000Z",
      skipped: ["huge.json"],
    });
    assert.equal(result.phase, PlanPhase.Started);
    assert.equal(result.nextStep, PlanNextStep.Plan);
    assert.deepEqual(result.skipped, ["huge.json"]);
  });

  test("an unreadable plan-state.json is no history", async () => {
    write(PLAN_STATE_FILE, "{not json");
    assert.equal(await readPlanStateManifest(workDir), null);
  });
});

describe("plan-state bundle", () => {
  test("round-trips the manifest and the files", () => {
    const body = encodePlanStateBundle({
      manifest: manifest({ loopId: "loop-9" }),
      files: [
        { path: "plan.json", data: Buffer.from("{}") },
        { path: "reviews/a.json", data: Buffer.from([0, 1, 2, 255]) },
      ],
    });
    const decoded = decodePlanStateBundle(body);
    assert.equal(decoded.manifest.loopId, "loop-9");
    assert.deepEqual(
      decoded.files.map((file) => [file.path, [...file.data]]),
      [
        ["plan.json", [...Buffer.from("{}")]],
        ["reviews/a.json", [0, 1, 2, 255]],
      ]
    );
  });

  test("rejects paths outside the work directory or outside the plan state", () => {
    for (const bad of [
      "../escape.md",
      "/etc/passwd",
      "reviews/../../escape.md",
      String.raw`..\escape.md`,
      ".agentflow-ai/config.env",
      ".env",
      "claude-output-1.jsonl",
    ]) {
      assert.throws(
        () => decodePlanStateBundle(rawBundle([{ path: bad, data: "" }])),
        Error,
        bad
      );
    }
  });

  test("restoring replaces the plan state and leaves runtime output", async () => {
    write("plan.json", "stale plan");
    write("stale-notes.md", "from an older loop");
    write("symphony-loop.log", "runner log");
    const linkTarget = path.join(root, "elsewhere");
    mkdirSync(linkTarget);
    // A junction on Windows, which needs no privilege; a symlink elsewhere.
    symlinkSync(linkTarget, path.join(workDir, "reviews"), "junction");

    await extractPlanStateBundle(
      {
        manifest: manifest({ loopId: "loop-2" }),
        files: [
          { path: "plan.json", data: Buffer.from("restored plan") },
          { path: "reviews/a.json", data: Buffer.from("review") },
        ],
      },
      workDir
    );

    assert.equal(
      readFileSync(path.join(workDir, "plan.json"), "utf8"),
      "restored plan"
    );
    assert.equal(existsSync(path.join(workDir, "stale-notes.md")), false);
    assert.equal(
      readFileSync(path.join(workDir, "symphony-loop.log"), "utf8"),
      "runner log"
    );
    assert.equal(lstatSync(path.join(workDir, "reviews")).isDirectory(), true);
    assert.equal(
      existsSync(path.join(linkTarget, "a.json")),
      false,
      "never written through a symlink"
    );
  });

  test("a work directory is current when it saved the state or grew from it", () => {
    const remote = manifest({ loopId: "loop-2" });
    const entry = (loopId: string) => ({
      loopId,
      command: LoopCommand.Plan,
      outcome: PlanLoopOutcome.Succeeded,
      savedAt: "2026-10-11T00:00:00.000Z",
      phase: PlanPhase.Planned,
    });
    assert.equal(isLocalPlanStateCurrent(null, remote), false);
    assert.equal(
      isLocalPlanStateCurrent(manifest({ loopId: "loop-2" }), remote),
      true
    );
    assert.equal(
      isLocalPlanStateCurrent(
        manifest({
          loopId: "loop-3",
          history: [entry("loop-2"), entry("loop-3")],
        }),
        remote
      ),
      true
    );
    assert.equal(
      isLocalPlanStateCurrent(
        manifest({ loopId: "loop-1", history: [entry("loop-1")] }),
        remote
      ),
      false
    );
  });
});
