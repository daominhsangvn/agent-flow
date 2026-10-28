import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import {
  committedWhileRunning,
  loopBranchDiffStats,
  parseNumstat,
} from "../src/headless/headless-branch-diff.js";

const WORK_BRANCH = "symphony/pln-2";
const PLAN_STARTED = "2026-10-13T13:06:46.171Z";
const EXECUTE_STARTED = "2026-10-13T15:01:35.725Z";
const EXECUTE_COMMITTED = "2026-10-13T15:14:27Z";
const EXECUTE_ENDED = "2026-10-13T15:14:28.240Z";
const STEP_STARTED = "2026-10-13T15:14:33.745Z";
const STEP_ENDED = "2026-10-13T15:15:08.640Z";

function git(cwd: string, args: string[], at = "2026-10-13T10:00:00Z"): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentFlow",
      GIT_AUTHOR_EMAIL: "agentflow@example.com",
      GIT_COMMITTER_NAME: "AgentFlow",
      GIT_COMMITTER_EMAIL: "agentflow@example.com",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    },
  });
}

/**
 * A clone like the runner's: `origin/main` plus the plan's worktree on its
 * work branch, where the implementation committed a license and a README line.
 */
function makeLoopWorktree(): { root: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-diff-"));
  const origin = path.join(root, "origin");
  const clone = path.join(root, "clone");
  const worktree = path.join(root, "loops", "pln-2", "calculator-app");
  fs.mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(
    path.join(origin, "README.md"),
    "# calculator-app\n\nA calculator.\n"
  );
  git(origin, ["add", "."]);
  git(origin, ["commit", "-q", "-m", "Initial commit"]);
  git(root, ["clone", "-q", origin, clone]);
  git(clone, [
    "worktree",
    "add",
    "-q",
    "-b",
    WORK_BRANCH,
    worktree,
    "origin/main",
  ]);
  fs.writeFileSync(
    path.join(worktree, "LICENSE"),
    "MIT License\n\nCopyright (c) 2026\n"
  );
  fs.writeFileSync(
    path.join(worktree, "README.md"),
    "# calculator-app\n\nA calculator, MIT licensed.\n"
  );
  fs.writeFileSync(path.join(worktree, "logo.bin"), Buffer.from([0, 1, 2, 0]));
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-q", "-m", "PLN-2"], EXECUTE_COMMITTED);
  return { root, worktree };
}

test("the implementation loop that committed reports the branch's diff", async () => {
  const { root, worktree } = makeLoopWorktree();
  try {
    const result = await loopBranchDiffStats({
      worktreeDir: worktree,
      baseBranch: "main",
      workBranch: WORK_BRANCH,
      startedAt: EXECUTE_STARTED,
      endedAt: EXECUTE_ENDED,
      now: new Date(STEP_ENDED),
    });
    assert.deepEqual(result, {
      known: true,
      // LICENSE +3, README +1 -1, a binary file with no lines.
      stats: {
        linesAdded: 4,
        linesRemoved: 1,
        filesChanged: 3,
        source: LOC_SOURCE_GIT,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a loop of the same branch that committed nothing reports none", async () => {
  const { root, worktree } = makeLoopWorktree();
  try {
    for (const [startedAt, endedAt] of [
      // The plan ran before the implementation committed.
      [PLAN_STARTED, "2026-10-13T13:14:26.199Z"],
      // The release notes step started seconds after that commit.
      [STEP_STARTED, STEP_ENDED],
    ] as const) {
      const result = await loopBranchDiffStats({
        worktreeDir: worktree,
        baseBranch: "main",
        workBranch: WORK_BRANCH,
        startedAt,
        endedAt,
        now: new Date(STEP_ENDED),
      });
      assert.deepEqual(result, { known: true, stats: null });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree or branch git cannot read is unknown, not zero", async () => {
  const { root, worktree } = makeLoopWorktree();
  try {
    const input = {
      worktreeDir: worktree,
      baseBranch: "main",
      workBranch: WORK_BRANCH,
      startedAt: EXECUTE_STARTED,
      endedAt: EXECUTE_ENDED,
      now: new Date(STEP_ENDED),
    };
    assert.deepEqual(
      await loopBranchDiffStats({ ...input, workBranch: "symphony/pln-9" }),
      { known: false }
    );
    assert.deepEqual(
      await loopBranchDiffStats({
        ...input,
        worktreeDir: path.join(root, "gone"),
      }),
      { known: false }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a commit counts for the loop that ran when it was made", () => {
  const commitAt = String(Date.parse(EXECUTE_COMMITTED) / 1000);
  const window = { now: new Date(STEP_ENDED) };
  assert.equal(
    committedWhileRunning(`${commitAt}\n`, {
      ...window,
      startedAt: EXECUTE_STARTED,
      endedAt: EXECUTE_ENDED,
    }),
    true
  );
  assert.equal(
    committedWhileRunning(commitAt, {
      ...window,
      startedAt: STEP_STARTED,
      endedAt: STEP_ENDED,
    }),
    false
  );
  // A running loop counts its commits up to now.
  assert.equal(
    committedWhileRunning(commitAt, {
      startedAt: EXECUTE_STARTED,
      endedAt: null,
      now: new Date("2026-10-13T15:20:00Z"),
    }),
    true
  );
  assert.equal(
    committedWhileRunning("", {
      ...window,
      startedAt: EXECUTE_STARTED,
      endedAt: null,
    }),
    false
  );
});

test("numstat totals count binary files as changed and skip other lines", () => {
  assert.deepEqual(
    parseNumstat("21\t0\tLICENSE\n5\t1\tREADME.md\n-\t-\tlogo.png\n\nnoise\n"),
    {
      linesAdded: 26,
      linesRemoved: 1,
      filesChanged: 3,
      source: LOC_SOURCE_GIT,
    }
  );
  assert.equal(parseNumstat(""), null);
});
