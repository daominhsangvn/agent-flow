/**
 * @file headless-branch-diff.ts
 * @description The code a loop shipped on its work branch, for the Sessions
 * page's "Lines changed" (`branchDiffStats`, the branch total): the work
 * branch's diff against the base it was cut from, read with git from the
 * loop's worktree. Only a loop that committed to the branch gets it. The plan
 * loop of the same branch, or a step after the implementation that commits
 * nothing, did not write that code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";

export type BranchDiffStats = NonNullable<
  SyncedAgentSession["branchDiffStats"]
>;

/** The loop's branch diff, null when it committed nothing; or not readable. */
export type BranchDiffResult =
  | { known: true; stats: BranchDiffStats | null }
  | { known: false };

export type LoopBranchDiffInput = {
  worktreeDir: string;
  baseBranch: string;
  workBranch: string;
  startedAt: string;
  /** Null while the loop runs: its commits so far count. */
  endedAt: string | null;
  now: Date;
};

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
/** git records commit times in whole seconds. */
const COMMIT_TIME_SLACK_S = 2;
const NUMSTAT_BINARY = "-";

export async function loopBranchDiffStats(
  input: LoopBranchDiffInput
): Promise<BranchDiffResult> {
  const head = `refs/heads/${input.workBranch}`;
  const base = await mergeBase(input.worktreeDir, input.baseBranch, head);
  if (!base) {
    return { known: false };
  }
  const commitTimes = await git(input.worktreeDir, [
    "log",
    "--format=%ct",
    `${base}..${head}`,
  ]);
  if (commitTimes === null) {
    return { known: false };
  }
  if (!committedWhileRunning(commitTimes, input)) {
    return { known: true, stats: null };
  }
  const numstat = await git(input.worktreeDir, [
    "diff",
    "--numstat",
    base,
    head,
  ]);
  return numstat === null
    ? { known: false }
    : { known: true, stats: parseNumstat(numstat) };
}

/** Whether a commit (`git log --format=%ct` output) was made while the loop ran. */
export function committedWhileRunning(
  commitTimes: string,
  window: Pick<LoopBranchDiffInput, "startedAt" | "endedAt" | "now">
): boolean {
  const from = Math.floor(Date.parse(window.startedAt) / 1000);
  const endedAt = window.endedAt
    ? Date.parse(window.endedAt)
    : window.now.getTime();
  const until = Math.ceil(endedAt / 1000) + COMMIT_TIME_SLACK_S;
  return commitTimes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .some((line) => {
      const at = Number(line);
      return at >= from && at <= until;
    });
}

/** Totals of `git diff --numstat`; a binary file counts as changed, with no lines. */
export function parseNumstat(output: string): BranchDiffStats | null {
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesChanged = 0;
  for (const line of output.split("\n")) {
    const [added, removed, file] = line.split("\t");
    if (!(added && removed && file)) {
      continue;
    }
    filesChanged += 1;
    linesAdded += lineCount(added);
    linesRemoved += lineCount(removed);
  }
  if (filesChanged === 0) {
    return null;
  }
  return {
    linesAdded: Math.min(linesAdded, PR_INT_MAX),
    linesRemoved: Math.min(linesRemoved, PR_INT_MAX),
    filesChanged: Math.min(filesChanged, PR_INT_MAX),
    source: LOC_SOURCE_GIT,
  };
}

/** The commit the work branch forked from: off the remote base, else the local one. */
async function mergeBase(
  worktreeDir: string,
  baseBranch: string,
  head: string
): Promise<string | null> {
  for (const base of [
    `refs/remotes/origin/${baseBranch}`,
    `refs/heads/${baseBranch}`,
  ]) {
    const commit = (await git(worktreeDir, ["merge-base", base, head]))?.trim();
    if (commit) {
      return commit;
    }
  }
  return null;
}

/** git's output, or null when it failed (e.g. the worktree or a ref is gone). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch {
    return null;
  }
}

function lineCount(value: string): number {
  if (value === NUMSTAT_BINARY) {
    return 0;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}
