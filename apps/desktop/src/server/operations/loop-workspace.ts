import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { PREVIOUS_WORK_DIR } from "./loop-replan.js";
import { resolveWorktreeParentDir } from "./symphony-utils.js";

/**
 * The workspace of a loop on project repositories (repositories a project
 * takes from its integration connections): one folder per loop key,
 * `<worktree parent>/loops/<key>`, holding
 *
 * - every repository's loop worktree as a subdirectory (`<key>/<repo name>`),
 *   all equal — no repository is primary to the agent;
 * - `CLAUDE.md` with the project's agent instructions and the list of
 *   repositories. The folder is not a repository, so it is never committed
 *   and never touches a repository's own `CLAUDE.md` / `AGENTS.md`, which
 *   Claude Code loads when it works in that repository;
 * - `.agentflow-ai/work` (PRD, plan, state) and `.claude/agents`.
 *
 * The agent runs from the workspace folder. The loop worktrees are created
 * by the usual worktree code: `resolveLoopWorktreeDir` asks
 * `loopWorkspaceDirFor` where a repository's worktree goes while the loop's
 * request is handled.
 */

const UNSAFE_DIR_CHARS_RE = /[^A-Za-z0-9._-]+/g;
const LEADING_DOTS_RE = /^\.+/;
const WORKSPACE_DIR = "loops";
const RESERVED_NAMES = new Set([".claude", ".agentflow-ai", "claude.md"]);

export type LoopWorkspaceRepo = {
  fullName: string;
  /** The repository's checkout, the worktrees' parent repository. */
  repoPath: string;
};

type OpenWorkspace = {
  rootDir: string;
  worktreeKey: string;
  dirNames: Map<string, string>;
};

const workspaces = new Map<string, OpenWorkspace>();

/**
 * Opens the loop's workspace: creates its folder and decides each
 * repository's subdirectory. PLAN starts from a fresh work directory (a prior
 * plan must not be reused); EXECUTE and REQUEST_CHANGES keep it. A re-plan
 * (`keepPrevious`) keeps the earlier work directory aside as
 * `previous-work`, for preparePlanWorkDir (loop-replan.ts) to hand over.
 */
export async function openLoopWorkspace(input: {
  loopId: string;
  command: string;
  worktreeKey: string;
  repos: readonly LoopWorkspaceRepo[];
  /** Start from a clean work directory (default: PLAN only). */
  fresh?: boolean;
  /** Fresh, but keep the earlier work directory as `previous-work`. */
  keepPrevious?: boolean;
}): Promise<string | null> {
  const first = input.repos[0];
  if (!first) {
    return null;
  }
  // Checkouts sit at <workspace>/<host>/<owner>__<repo> (loop-repo-checkout.ts);
  // loop workspaces at <workspace>/loops/<key>, whatever host their repositories are on.
  const rootDir = path.join(
    resolveWorktreeParentDir(path.dirname(first.repoPath)),
    WORKSPACE_DIR,
    input.worktreeKey
  );
  if (input.fresh ?? input.command === LoopCommand.Plan) {
    const stateDir = path.join(rootDir, ".agentflow-ai");
    const previousDir = path.join(stateDir, PREVIOUS_WORK_DIR);
    await fs.rm(previousDir, { recursive: true, force: true });
    if (input.keepPrevious && existsSync(path.join(stateDir, "work"))) {
      await fs.rename(path.join(stateDir, "work"), previousDir);
    } else {
      await fs.rm(path.join(stateDir, "work"), {
        recursive: true,
        force: true,
      });
    }
  }
  await fs.mkdir(rootDir, { recursive: true });
  workspaces.set(input.loopId, {
    rootDir,
    worktreeKey: input.worktreeKey,
    dirNames: workspaceDirNames(input.repos),
  });
  return rootDir;
}

export function closeLoopWorkspace(loopId: string): void {
  workspaces.delete(loopId);
}

/**
 * Where the worktree of `repoPath` goes for `stableId` (the loop key, or the
 * key plus a suffix for an additional repository), or null when no open
 * workspace holds that repository.
 */
export function loopWorkspaceDirFor(
  repoPath: string,
  stableId: string
): string | null {
  const resolved = path.resolve(repoPath);
  for (const workspace of workspaces.values()) {
    const ownsKey =
      stableId === workspace.worktreeKey ||
      stableId.startsWith(`${workspace.worktreeKey}-`);
    const dirName = workspace.dirNames.get(resolved);
    if (ownsKey && dirName) {
      return path.join(workspace.rootDir, dirName);
    }
  }
  return null;
}

export type WorkspaceRepoEntry = {
  /** Defaults to the directory name. */
  fullName?: string;
  dir: string;
  /** Defaults to main. */
  baseBranch?: string;
};

/**
 * Writes the workspace's `CLAUDE.md`: the project's instructions, then the
 * repositories. Claude Code loads a repository's own `CLAUDE.md` when it
 * works in that subdirectory, but not a nested `AGENTS.md`, so the
 * `AGENTS.md` of a repository without a `CLAUDE.md` is imported here.
 */
export async function writeLoopWorkspaceInstructions(input: {
  rootDir: string;
  instructions: string | undefined;
  repos: readonly WorkspaceRepoEntry[];
  /** Markdown appended at the end (a process step's section). */
  extra?: string;
}): Promise<void> {
  const imports: string[] = [];
  const rows = input.repos.map((repo) => {
    const dir =
      path.relative(input.rootDir, repo.dir).split(path.sep).join("/") || ".";
    const ownDocs = ["CLAUDE.md", "AGENTS.md"].filter((file) =>
      existsSync(path.join(repo.dir, file))
    );
    if (ownDocs.length === 1 && ownDocs[0] === "AGENTS.md") {
      imports.push(`@${dir}/AGENTS.md`);
    }
    const docs = ownDocs.length > 0 ? ownDocs.join(", ") : "none";
    const fullName = repo.fullName || path.basename(repo.dir);
    return `| \`${dir}/\` | ${fullName} | \`${repo.baseBranch || "main"}\` | ${docs} |`;
  });
  const instructions = input.instructions?.trim();
  const content = [
    "# Project workspace",
    "",
    "This folder is the project's workspace, not a repository. Every repository",
    "of the project is a subdirectory below, checked out on this loop's branch.",
    "Each repository's own CLAUDE.md / AGENTS.md describes its conventions;",
    "follow it when changing that repository. Run git, builds and tests inside",
    "the repository they belong to.",
    "",
    ...(instructions ? ["## Project instructions", "", instructions, ""] : []),
    "## Workspace repositories",
    "",
    "| Directory | Repository | Based on | Own instructions |",
    "|---|---|---|---|",
    ...rows,
    "",
    ...(imports.length > 0
      ? ["## Repository instructions (AGENTS.md)", "", ...imports, ""]
      : []),
    ...(input.extra ? [input.extra.trim(), ""] : []),
  ].join("\n");
  await fs.writeFile(path.join(input.rootDir, "CLAUDE.md"), content, "utf8");
}

/** Repository name, else its path-safe full name, unique within the workspace. */
function workspaceDirNames(
  repos: readonly LoopWorkspaceRepo[]
): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const repo of repos) {
    const segments = repo.fullName.split("/").map(safeSegment);
    let name = segments.at(-1) ?? "";
    if (
      !name ||
      used.has(name.toLowerCase()) ||
      RESERVED_NAMES.has(name.toLowerCase())
    ) {
      name = segments.filter(Boolean).join("__") || `repo-${used.size + 1}`;
    }
    used.add(name.toLowerCase());
    names.set(path.resolve(repo.repoPath), name);
  }
  return names;
}

function safeSegment(segment: string): string {
  return segment
    .trim()
    .replace(UNSAFE_DIR_CHARS_RE, "-")
    .replace(LEADING_DOTS_RE, "");
}
