import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import {
  LOOP_STEP_OPTION_MAX,
  LOOP_STEP_OPTIONS_MAX,
  LOOP_STEP_QUESTION_MAX,
  LOOP_STEP_QUESTIONS_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepConfig,
  LoopStepFile,
  LoopStepFinish,
} from "@agentflow-ai/loops-api/loop-step";
import { excludeAgentFlowFiles } from "./loop-repo-checkout.js";

/**
 * The personal runner (docs/runner.md "Personal runner"): a runner on a
 * person's own computer for ONE AgentFlow project. Its loops run in the
 * project folder the person already works in (no clone, no worktree), with
 * every credential of the machine (git, gh, the person's Claude Code
 * plugins, commands and MCP servers); only the Claude model provider comes
 * from AgentFlow with each loop. It runs workflow process steps (STEP loops)
 * of its project only: one at a time, or several when the person said the
 * project's commands can (they make their own worktrees). Each run has its
 * own work directory (`.agentflow-ai/runs/<run id>`), so parallel runs never
 * share their issue, questions or agent session.
 *
 * The personal runner's entry point configures it once at startup; the
 * gateway operations read it, so the regular runner and the desktop app,
 * which never configure it, behave as before.
 */

export type PersonalRunnerProject = {
  /** AgentFlow project key (the project's slug, e.g. `PRO-1`). */
  projectKey: string;
  /** The project folder loops run in. */
  projectDir: string;
  /** Several loops may run in the folder at once. */
  parallel: boolean;
  /**
   * The agent may use any tool without a permission prompt
   * (`--permission-mode bypassPermissions`); otherwise only the loop's
   * allowed tools and the person's own `permissions.allow`.
   */
  skipPermissions: boolean;
};

export type PersonalLoopRequest = {
  command: string;
  projectKey?: string;
  step?: LoopStepConfig;
};

/** Work directories of the runs, inside the project folder's `.agentflow-ai`. */
const RUNS_DIR = path.join(".agentflow-ai", "runs");
/** A step's workspace paths under this prefix are files of the run's work directory. */
const WORK_PATH_PREFIX = `${LOOP_STEP_WORK_DIR}/`;
/** A run's work directory unused this long is removed when another run starts. */
const STALE_RUN_MS = 30 * 24 * 60 * 60_000;
const UNSAFE_RUN_ID_CHARS_RE = /[^A-Za-z0-9._-]+/g;

let configured: PersonalRunnerProject | null = null;

export function configurePersonalRunnerProject(
  project: PersonalRunnerProject | null
): void {
  configured = project
    ? { ...project, projectDir: path.resolve(project.projectDir) }
    : null;
}

/** The personal runner's project, or null on any other runner or desktop. */
export function getPersonalRunnerProject(): PersonalRunnerProject | null {
  return configured;
}

/** Project keys are compared ignoring case (`pro-1` is `PRO-1`). */
export function samePersonalProjectKey(
  a: string | undefined,
  b: string | undefined
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.trim().toUpperCase() === b.trim().toUpperCase()
  );
}

/**
 * Why the personal runner refuses a loop, or null when it runs it: another
 * project's loop, a loop that is not a process step, a step AgentFlow would
 * commit and push (the person's own commands do that here), or, unless the
 * project's commands run in parallel, a second loop while one already works
 * in the project folder.
 */
export function personalLoopRejection(
  body: PersonalLoopRequest,
  project: PersonalRunnerProject,
  otherLoopRunning: boolean
): string | null {
  if (!samePersonalProjectKey(body.projectKey, project.projectKey)) {
    return `This personal runner runs only project ${project.projectKey}; the loop belongs to ${body.projectKey ?? "no project"}`;
  }
  if (body.command !== LoopCommand.Step) {
    return `A personal runner runs workflow process steps only, not ${body.command}`;
  }
  if (body.step?.finish === LoopStepFinish.Push) {
    return "A personal runner does not commit and push for a step (finish: push): the step's own commands do it with this computer's credentials";
  }
  if (otherLoopRunning && !project.parallel) {
    return `Another loop is running in ${project.projectDir}; this personal runner runs one loop at a time`;
  }
  return null;
}

/** True for the project folder itself, which is never removed like a worktree. */
export function isPersonalProjectDir(dir: string): boolean {
  return configured !== null && path.resolve(dir) === configured.projectDir;
}

/** The work directory of a workflow run: `<project>/.agentflow-ai/runs/<run id>`. */
export function personalRunWorkDir(projectDir: string, runId: string): string {
  const name = runId.replace(UNSAFE_RUN_ID_CHARS_RE, "-") || "run";
  return path.join(projectDir, RUNS_DIR, name);
}

/** Keeps `.agentflow-ai/` out of the person's `git status` (a git repository only). */
export async function excludePersonalProjectFiles(
  projectDir: string
): Promise<void> {
  if (isDirectory(path.join(projectDir, ".git"))) {
    await excludeAgentFlowFiles(projectDir);
  }
}

/**
 * Before a step: its run's work directory, created empty when the run's
 * first step starts (and work directories of runs unused for 30 days are
 * removed then); later steps and resumed sessions keep it.
 */
export async function preparePersonalRunWorkDir(input: {
  projectDir: string;
  runId: string;
  fresh: boolean;
}): Promise<string> {
  const workDir = personalRunWorkDir(input.projectDir, input.runId);
  if (input.fresh) {
    await fs.rm(workDir, { recursive: true, force: true });
    await removeStaleRunWorkDirs(input.projectDir, Date.now());
  }
  await fs.mkdir(workDir, { recursive: true });
  await excludePersonalProjectFiles(input.projectDir);
  return workDir;
}

/**
 * The workspace root of a step whose work directory is a personal run's:
 * the project folder. Null for any other work directory, whose root is two
 * levels up (`<root>/.agentflow-ai/work`).
 */
export function personalStepWorkspaceRoot(
  claudeWorkDir: string
): string | null {
  if (!configured) {
    return null;
  }
  const runs = path.join(configured.projectDir, RUNS_DIR) + path.sep;
  return path.resolve(claudeWorkDir).startsWith(runs)
    ? configured.projectDir
    : null;
}

/**
 * A personal step's files: workspace paths under `.agentflow-ai/work/` (a
 * step's reply or document file) are read from the run's own work
 * directory and keep their workspace path; every other glob matches in the
 * project folder.
 */
export function collectPersonalStepFiles<T extends { path: string }>(input: {
  projectDir: string;
  claudeWorkDir: string;
  globs: readonly string[];
  collect: (root: string, globs: readonly string[]) => T[];
}): T[] {
  const workGlobs = input.globs
    .filter((glob) => glob.startsWith(WORK_PATH_PREFIX))
    .map((glob) => glob.slice(WORK_PATH_PREFIX.length));
  const projectGlobs = input.globs.filter(
    (glob) => !glob.startsWith(WORK_PATH_PREFIX)
  );
  return [
    ...input
      .collect(input.claudeWorkDir, workGlobs)
      .map((file) => ({ ...file, path: `${WORK_PATH_PREFIX}${file.path}` })),
    ...input.collect(input.projectDir, projectGlobs),
  ];
}

/**
 * What the agent of a step is told, appended to its system prompt: the
 * project folder is the person's own (no `CLAUDE.md` is written into it),
 * and the run's files are in its own work directory (`$AGENTFLOW_WORKDIR`).
 */
export function personalStepInstructions(
  step: LoopStepConfig,
  workDir: string,
  roleLines: readonly string[] = []
): string {
  const lines = [
    `## Process step: ${step.name}`,
    "",
    "You run unattended as one step of an automated process, on the developer's own",
    "computer and in their project folder. Nobody can answer an interactive question",
    "while you work, and nobody sees this terminal.",
    `- This run's work directory is \`${workDir}\` (also \`$AGENTFLOW_WORKDIR\`). Other runs may work in this folder at the same time: keep this run's files there.`,
    `- The issue this run works on is in \`${path.join(workDir, LoopStepFile.Issue)}\`.`,
    "- Use this computer's own tools and credentials (git, gh, MCP servers) as your instructions say.",
  ];
  if (step.askQuestions) {
    lines.push(
      `- When you need a decision, do not ask in the terminal and do not guess: write the questions to \`${path.join(workDir, LoopStepFile.Questions)}\` as a JSON array of \`{"id": "q1", "question": "...", "options": ["..."]}\` (options optional), then stop. The questions are shown in AgentFlow; the run resumes this session with the answers.`,
      `- Limits of that file: at most ${LOOP_STEP_QUESTIONS_MAX} questions; each question at most ${LOOP_STEP_QUESTION_MAX} characters; at most ${LOOP_STEP_OPTIONS_MAX} options per question, each at most ${LOOP_STEP_OPTION_MAX} characters.`
    );
  } else {
    lines.push(
      "- Do not stop to ask questions: make the most reasonable choice and note it."
    );
  }
  lines.push(...roleLines);
  const toolkit = step.toolkit?.instructions.trim();
  if (toolkit) {
    lines.push("", "### Toolkit", "", toolkit);
  }
  return lines.join("\n");
}

async function removeStaleRunWorkDirs(
  projectDir: string,
  now: number
): Promise<void> {
  const runsDir = path.join(projectDir, RUNS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(runsDir, name);
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory() && now - stat.mtimeMs > STALE_RUN_MS) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } catch {
      // Best effort: another run may be removing it.
    }
  }
}

function isDirectory(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isDirectory();
  } catch {
    return false;
  }
}
