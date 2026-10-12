/**
 * @file headless-workspace.ts
 * @description Workspace settings the desktop asks a person to confirm in its
 * UI, set automatically for the headless runner. Loops create worktrees next
 * to the repository (symphony-utils resolveWorktreeParentDir), which on a
 * runner is the workspace directory, so that is recorded as the confirmed
 * worktree parent and the System Check passes.
 */

import {
  loadReposConfig,
  updateSettings,
} from "../server/operations/repos-config-utils.js";

/** Records the workspace as the worktree parent unless one was confirmed already. */
export async function ensureRunnerWorktreeSettings(
  configDir: string,
  workspaceDir: string
): Promise<void> {
  const { settings } = await loadReposConfig(configDir);
  if (settings.worktreeParentDir && settings.worktreeParentDirConfirmed) {
    return;
  }
  await updateSettings(
    { worktreeParentDir: workspaceDir, worktreeParentDirConfirmed: true },
    configDir
  );
}
