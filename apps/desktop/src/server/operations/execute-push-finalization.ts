import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LoopArtifactFile } from "@agentflow-ai/loops-api/artifacts";
import { sanitizeErrorMessage } from "../../main/diagnostics/diagnostics-helpers.js";

/**
 * EXECUTE finalization for a project repository: commit what the agent team
 * changed and push the loop branch. No pull request is opened here — for a
 * project repository that is a workflow action ("Create pull request" of the
 * repository's integration), run after the agent team finishes.
 */

const execFileAsync = promisify(execFile);
const GIT_LOCAL_TIMEOUT_MS = 30_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
const HEADING_RE = /^#{1,3}\s+(.+?)\s*#*\s*$/m;
// "Implementation plan — RC-1: Make it work" names the document, not the change.
const DOCUMENT_KIND_PREFIX_RE =
  /^(?:implementation plan|plan|prd|product requirements(?: document)?)\s*[—–:-]\s+(?=\S)/i;
const DEFAULT_SUBJECT = "Changes from AgentFlow";
const SUBJECT_MAX_LENGTH = 100;
const FALLBACK_COMMITTER = {
  name: "AgentFlow",
  email: "agentflow@users.noreply.agentflow.local",
};

export type PushFinalizationInput = {
  worktreeDir: string;
  claudeWorkDir: string;
  baseBranch: string;
  loopId: string;
  artifactSlug?: string;
  committer?: { name: string; email: string };
  gitBin: string;
  /** Process environment plus the loop's git credentials. */
  env: NodeJS.ProcessEnv;
};

export type PushFinalizationOutcome =
  | { kind: "pushed"; branchName: string; commitSha: string }
  | { kind: "no-changes"; branchName: string; commitSha: string | null }
  | { kind: "error"; reason: string };

export async function commitAndPushLoopBranch(
  input: PushFinalizationInput
): Promise<PushFinalizationOutcome> {
  try {
    const branchName = await git(input, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branchName || branchName === "HEAD") {
      return { kind: "error", reason: "the worktree is not on a branch" };
    }
    // Stage everything, then unstage AgentFlow's files. An exclude pathspec
    // would fail when they are already ignored (`.git/info/exclude`).
    await git(input, ["add", "-A", "--", "."]);
    await git(input, ["reset", "-q", "--", ".claude", ".agentflow-ai"]);
    const staged = await git(input, ["diff", "--cached", "--name-only"]);
    if (staged) {
      await commit(input);
    }
    if (!(await hasCommitsBeyondBase(input))) {
      return {
        kind: "no-changes",
        branchName,
        commitSha: await gitOrNull(input, ["rev-parse", "HEAD"]),
      };
    }
    await git(input, ["push", "-u", "origin", "HEAD"], GIT_PUSH_TIMEOUT_MS);
    const commitSha = await git(input, ["rev-parse", "HEAD"]);
    return { kind: "pushed", branchName, commitSha };
  } catch (error) {
    return { kind: "error", reason: gitErrorText(error) };
  }
}

/**
 * Subject from the plan's (else the requirements') first heading, read from
 * the work directory, else from the workspace that holds the worktree (the
 * work directory of a loop on project repositories is at the workspace root).
 */
export function buildCommitSubject(
  claudeWorkDir: string,
  artifactSlug: string | undefined,
  worktreeDir?: string
): string {
  const workDirs = worktreeDir
    ? [
        claudeWorkDir,
        path.join(path.dirname(worktreeDir), ".agentflow-ai", "work"),
      ]
    : [claudeWorkDir];
  const files = [LoopArtifactFile.PlanMarkdown, LoopArtifactFile.Prd];
  const title =
    files
      .flatMap((file) => workDirs.map((dir) => path.join(dir, file)))
      .map(firstHeading)
      .find((heading) => heading !== null) ?? DEFAULT_SUBJECT;
  const subject = artifactSlug ? `${artifactSlug}: ${title}` : title;
  return subject.length > SUBJECT_MAX_LENGTH
    ? `${subject.slice(0, SUBJECT_MAX_LENGTH - 1)}…`
    : subject;
}

async function commit(input: PushFinalizationInput): Promise<void> {
  const committer =
    input.committer ??
    ((await gitOrNull(input, ["config", "user.email"]))
      ? null
      : FALLBACK_COMMITTER);
  const env: NodeJS.ProcessEnv = committer
    ? {
        ...input.env,
        GIT_AUTHOR_NAME: committer.name,
        GIT_AUTHOR_EMAIL: committer.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      }
    : input.env;
  await git({ ...input, env }, [
    "commit",
    "-m",
    buildCommitSubject(
      input.claudeWorkDir,
      input.artifactSlug,
      input.worktreeDir
    ),
    "-m",
    `Loop ID: ${input.loopId}`,
  ]);
}

/** Whether HEAD has commits its base branch on the remote does not. */
async function hasCommitsBeyondBase(
  input: PushFinalizationInput
): Promise<boolean> {
  const base = `refs/remotes/origin/${input.baseBranch}`;
  const range = (await gitOrNull(input, ["rev-parse", "--verify", base]))
    ? [`${base}..HEAD`]
    : ["HEAD", "--not", "--remotes=origin"];
  const count = await git(input, ["rev-list", "--count", ...range]);
  return Number.parseInt(count, 10) > 0;
}

async function git(
  input: PushFinalizationInput,
  args: string[],
  timeout = GIT_LOCAL_TIMEOUT_MS
): Promise<string> {
  const { stdout } = await execFileAsync(input.gitBin, args, {
    cwd: input.worktreeDir,
    env: input.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOrNull(
  input: PushFinalizationInput,
  args: string[]
): Promise<string | null> {
  try {
    return (await git(input, args)) || null;
  } catch {
    return null;
  }
}

function firstHeading(filePath: string): string | null {
  try {
    const match = HEADING_RE.exec(readFileSync(filePath, "utf8"));
    const heading = match?.[1]?.trim();
    return heading ? heading.replace(DOCUMENT_KIND_PREFIX_RE, "") : null;
  } catch {
    return null;
  }
}

function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  let text = error instanceof Error ? error.message : String(error);
  if (typeof stderr === "string" && stderr.trim()) {
    text = stderr;
  }
  return sanitizeErrorMessage(text.trim()).slice(0, 500);
}
