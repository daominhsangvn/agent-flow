import path from "node:path";
import type { LoopRequestBody } from "@agentflow-ai/loops-api/desktop-request";
import { buildLoopGitEnv, grantLoopGitAccess } from "./loop-git-access.js";
import { ensureProjectRepoCheckout } from "./loop-repo-checkout.js";
import type { LoopWorkspaceRepo } from "./loop-workspace.js";

/**
 * Prepares a loop's project repositories before its worktrees are created:
 * every repository the API sent with a `cloneUrl` (the loop's first one and
 * the others) is cloned or fetched with the loop's git credentials, and the
 * others are pointed at their checkout through `localRepoPath`, so the
 * existing peer-worktree code creates their worktrees. The returned checkouts
 * open the loop workspace (loop-workspace.ts), where all of them are equal
 * subdirectories of the folder the agent runs in.
 */

export type ProjectRepoPreparation =
  | {
      ok: true;
      /** Checkout of the primary repository, or null when it has no cloneUrl. */
      primaryPath: string | null;
      /** Git credentials of the loop, or null when no repository needs them. */
      gitEnv: Record<string, string> | null;
      /** Every checkout, the loop's first repository first. */
      repos: LoopWorkspaceRepo[];
    }
  | { ok: false; message: string };

export type ProjectRepoPreparationInput = {
  body: Pick<
    LoopRequestBody,
    "loopId" | "agentFlowAuthToken" | "repo" | "additionalRepos"
  >;
  apiBaseUrl: string;
  allowedDirs: string[];
  gitBin: string;
  getSymphonyDir?: () => string;
};

export async function prepareProjectRepos(
  input: ProjectRepoPreparationInput
): Promise<ProjectRepoPreparation> {
  const { body } = input;
  const additional = (body.additionalRepos ?? []).filter(
    (entry) => entry.cloneUrl && entry.fullName
  );
  if (!(body.repo?.cloneUrl || additional.length > 0)) {
    return { ok: true, primaryPath: null, gitEnv: null, repos: [] };
  }
  const gitEnv = buildLoopGitEnv({
    apiBaseUrl: input.apiBaseUrl,
    loopId: body.loopId,
    token: body.agentFlowAuthToken,
  });
  const options = {
    allowedDirs: input.allowedDirs,
    gitBin: input.gitBin,
    env: { ...process.env, ...gitEnv },
    loopId: body.loopId,
    configDir: resolveConfigDir(input.getSymphonyDir),
  };

  let primaryPath: string | null = null;
  if (body.repo?.cloneUrl) {
    const checkout = await ensureProjectRepoCheckout(
      { fullName: body.repo.fullName, cloneUrl: body.repo.cloneUrl },
      options
    );
    if (!checkout.ok) {
      return { ok: false, message: checkout.reason };
    }
    primaryPath = checkout.path;
  }
  const repos: LoopWorkspaceRepo[] =
    primaryPath && body.repo
      ? [{ fullName: body.repo.fullName, repoPath: primaryPath }]
      : [];
  for (const entry of additional) {
    const checkout = await ensureProjectRepoCheckout(
      { fullName: entry.fullName ?? "", cloneUrl: entry.cloneUrl ?? "" },
      options
    );
    if (!checkout.ok) {
      return { ok: false, message: checkout.reason };
    }
    entry.localRepoPath = checkout.path;
    repos.push({ fullName: entry.fullName ?? "", repoPath: checkout.path });
  }

  // Worktree creation fetches in these checkouts, outside the agent's env.
  grantLoopGitAccess(
    body.loopId,
    gitEnv,
    repos.map((repo) => repo.repoPath)
  );
  return { ok: true, primaryPath, gitEnv, repos };
}

function resolveConfigDir(getSymphonyDir?: () => string): string | null {
  if (!getSymphonyDir) {
    return null;
  }
  try {
    return path.join(getSymphonyDir(), "config");
  } catch {
    return null;
  }
}
