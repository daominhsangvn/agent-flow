import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LoopArtifactType } from "@agentflow-ai/loops-api/artifacts";
import {
  PLAN_BASE_FILE,
  PREVIOUS_PLAN_JSON,
  PREVIOUS_PLAN_MD,
  PREVIOUS_WORK_DIR,
  preparePlanWorkDir,
} from "../src/server/operations/loop-replan.js";
import { PLAN_STATE_FILE } from "../src/server/operations/plan-state-bundle.js";

const GIT = "git";
const QUESTION_RE = /Q-001/;
const KEPT_RE = /exploration kept/;
const REDONE_RE = /exploration redone/;
const SCRATCH_RE = /planning from scratch/;
let root: string;
let workspaceRoot: string;
let worktreeDir: string;
let workDir: string;
let previousDir: string;
let logs: string[];

function git(...args: string[]): string {
  return execFileSync(GIT, ["-C", worktreeDir, ...args], {
    encoding: "utf8",
  }).trim();
}

function commit(message: string): string {
  writeFileSync(path.join(worktreeDir, "README.md"), `${message}\n`);
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

/** What the earlier PLAN left in its work directory. */
function earlierPlan(base: string): void {
  mkdirSync(previousDir, { recursive: true });
  writeFileSync(
    path.join(previousDir, "plan.json"),
    JSON.stringify({ content: "# Plan\n- [ ] Q-001: x?" })
  );
  writeFileSync(path.join(previousDir, PLAN_BASE_FILE), `${base}\n`);
  writeFileSync(path.join(previousDir, "investigation-log.md"), "log");
  writeFileSync(path.join(previousDir, "requirements-extract.json"), "{}");
  writeFileSync(path.join(previousDir, "code-map.json"), "{}");
  writeFileSync(path.join(previousDir, "code-map-web.json"), "{}");
  writeFileSync(path.join(previousDir, "claude-output.jsonl"), "old stream");
  writeFileSync(path.join(previousDir, PLAN_STATE_FILE), '{"history":[]}');
}

function input(
  replan: boolean,
  artifacts: { type: string; content: string }[] = []
) {
  return {
    claudeWorkDir: workDir,
    worktreeDir,
    replan,
    artifacts,
    gitBin: GIT,
    log: (message: string) => logs.push(message),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-replan-"));
  workspaceRoot = path.join(root, "loops", "pln-6");
  worktreeDir = path.join(workspaceRoot, "calculator");
  workDir = path.join(workspaceRoot, ".agentflow-ai", "work");
  previousDir = path.join(workspaceRoot, ".agentflow-ai", PREVIOUS_WORK_DIR);
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  git("init", "-q");
  logs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PLAN work directory", () => {
  test("every PLAN records the commit it starts from", async () => {
    const head = commit("base");
    await preparePlanWorkDir(input(false));
    assert.equal(
      readFileSync(path.join(workDir, PLAN_BASE_FILE), "utf8").trim(),
      head
    );
    assert.equal(existsSync(path.join(workDir, PREVIOUS_PLAN_JSON)), false);
  });

  test("a re-plan at the same commit revises the earlier plan with its exploration", async () => {
    const head = commit("base");
    earlierPlan(head);
    await preparePlanWorkDir(input(true));
    const previous = JSON.parse(
      readFileSync(path.join(workDir, PREVIOUS_PLAN_JSON), "utf8")
    );
    assert.match(previous.content, QUESTION_RE);
    assert.deepEqual(
      readdirSync(workDir).sort(),
      [
        PLAN_BASE_FILE,
        "code-map-web.json",
        "code-map.json",
        "investigation-log.md",
        PLAN_STATE_FILE,
        PREVIOUS_PLAN_JSON,
        "requirements-extract.json",
      ].sort(),
      "the plan, its history and the exploration, never the old stream or plan.json itself"
    );
    assert.equal(
      existsSync(previousDir),
      false,
      "the earlier work directory is removed"
    );
    assert.match(logs.join("\n"), KEPT_RE);
  });

  test("a re-plan after the code moved on keeps the plan but explores again", async () => {
    const earlier = commit("base");
    earlierPlan(earlier);
    commit("someone merged");
    await preparePlanWorkDir(input(true));
    assert.ok(existsSync(path.join(workDir, PREVIOUS_PLAN_JSON)));
    assert.ok(existsSync(path.join(workDir, PLAN_STATE_FILE)), "history kept");
    assert.equal(existsSync(path.join(workDir, "investigation-log.md")), false);
    assert.match(logs.join("\n"), REDONE_RE);
  });

  test("without the earlier work directory a re-plan revises the plan document", async () => {
    commit("base");
    await preparePlanWorkDir(
      input(true, [
        { type: LoopArtifactType.Prd, content: "# PRD" },
        {
          type: LoopArtifactType.ImplementationPlan,
          content: "# Plan\n- [ ] Q-001: x?",
        },
      ])
    );
    assert.equal(
      readFileSync(path.join(workDir, PREVIOUS_PLAN_MD), "utf8"),
      "# Plan\n- [ ] Q-001: x?"
    );
    assert.equal(existsSync(path.join(workDir, PREVIOUS_PLAN_JSON)), false);
  });

  test("a re-plan with no earlier plan at all plans from scratch", async () => {
    commit("base");
    await preparePlanWorkDir(
      input(true, [
        { type: LoopArtifactType.ImplementationPlan, content: "  " },
      ])
    );
    assert.equal(existsSync(path.join(workDir, PREVIOUS_PLAN_MD)), false);
    assert.match(logs.join("\n"), SCRATCH_RE);
  });

  test("a plain PLAN removes a kept earlier work directory without using it", async () => {
    earlierPlan(commit("base"));
    await preparePlanWorkDir(input(false));
    assert.equal(existsSync(previousDir), false);
    assert.equal(existsSync(path.join(workDir, PREVIOUS_PLAN_JSON)), false);
  });
});
