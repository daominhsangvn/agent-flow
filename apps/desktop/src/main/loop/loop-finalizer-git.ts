import { execFileSync } from "node:child_process";
import { buildLoopGitEnv } from "../../server/operations/loop-git-access.js";
import { getResolvedGitPath } from "../../server/operations/symphony-loop.js";
import {
  assertPathAllowed,
  DirectoryNotAllowedError,
} from "../../server/security.js";
import type { LocalJob } from "../jobs/job-store.js";

/** Git helpers of loop finalization (loop-finalizer.ts). */

/** Best-effort current branch for a git worktree (matches symphony-loop getCurrentBranchImpl). */
function getCurrentBranchFromWorktree(worktreeDir: string): string | null {
  try {
    const branch = execFileSync(
      getResolvedGitPath(),
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }
    ).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export function getBranchNameFromAllowedWorktree(
  worktreeDir: string,
  getAllowedDirectories?: () => string[]
): string | undefined {
  if (getAllowedDirectories) {
    try {
      assertPathAllowed(worktreeDir, getAllowedDirectories());
    } catch (err) {
      if (err instanceof DirectoryNotAllowedError) {
        return undefined;
      }
      throw err;
    }
  }

  const branch = getCurrentBranchFromWorktree(worktreeDir);
  return branch ?? undefined;
}

/**
 * Git credentials of a loop on project repositories, for its EXECUTE
 * finalization; undefined for any other loop. A replayed finalization must
 * push like the live exit did: the gh path has no credentials for a project
 * repository and reads a clean worktree with an unpushed commit (left by a
 * push that failed) as "no changes", which drops the work.
 */
export function projectRepoGitEnv(
  job: Pick<LocalJob, "loopId" | "pushOnly">,
  apiBaseUrl: string,
  getToken: () => string | null
): Record<string, string> | undefined {
  if (!job.pushOnly) {
    return;
  }
  return buildLoopGitEnv({
    apiBaseUrl,
    loopId: job.loopId,
    token: getToken() ?? "",
  });
}
