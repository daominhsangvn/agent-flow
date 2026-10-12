import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LoopArtifactFile,
  LoopArtifactType,
} from "@agentflow-ai/loops-api/artifacts";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { LoopHarness } from "@agentflow-ai/loops-api/desktop-request";
import {
  LOOP_STEP_ARTIFACT_KEY,
  LOOP_STEP_FILE_BYTES_MAX,
  LOOP_STEP_FILES_MAX,
  LOOP_STEP_FILES_TOTAL_BYTES_MAX,
  LOOP_STEP_OPTION_MAX,
  LOOP_STEP_OPTIONS_MAX,
  LOOP_STEP_QUESTION_MAX,
  LOOP_STEP_QUESTIONS_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepCollectedFile,
  type LoopStepConfig,
  LoopStepConfigSchema,
  LoopStepFile,
  LoopStepFinish,
  type LoopStepQuestion,
  LoopStepQuestionsFileSchema,
  type LoopStepResult,
  type LoopStepToolkit,
} from "@agentflow-ai/loops-api/loop-step";
import { z } from "zod";
import {
  buildClaudePipeline,
  buildNativePromptPipeline,
  type SupportedRuntimeSelection,
} from "./harness-pipeline.js";

/**
 * STEP loops: one step of a project process (a toolkit command or any other
 * instruction) run by the agent from the loop workspace root
 * (@agentflow-ai/loops-api/loop-step). The run's steps share the workspace,
 * its worktrees and its work directory: a later step continues where the
 * previous one stopped. This module prepares the workspace (the step's
 * settings, the Issue, the toolkit's skills and commands), builds the agent
 * command, and reads what the step produced, for the live exit and boot
 * recovery alike.
 */

type StepRequestBody = {
  command: string;
  prompt?: string | null;
  parentSessionId?: string | null;
  step?: LoopStepConfig;
};

type StepArtifact = { type: string; title: string; content: string };

/** A workspace repository: its full name and its worktree. */
type StepRepository = { fullName?: string; dir: string };

/** Files of the previous step in the shared work directory. */
const PREVIOUS_STEP_FILES = [
  LoopStepFile.Questions,
  LoopArtifactFile.ExecutionResult,
  "claude-output.jsonl",
  "claude-stderr.log",
  "session-id.txt",
  "step-prompt.txt",
] as const;

const SESSION_ID_FILE = "session-id.txt";
const CLAUDE_OUTPUT_FILE = "claude-output.jsonl";
/** Directories never searched for step artifacts. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".agentflow-ai",
]);
const WALK_DEPTH_MAX = 10;
const WALK_ENTRIES_MAX = 20_000;
const QUESTIONS_ERROR_MAX = 500;
const GLOB_SPECIAL_RE = /[*?]/;
/** questions.json: the bare array, or `{"questions": [...]}`. */
const questionsFileSchema = z.union([
  LoopStepQuestionsFileSchema,
  z
    .object({ questions: LoopStepQuestionsFileSchema })
    .transform((file) => file.questions),
]);
/** A stream-json event that names its session. */
const sessionEventSchema = z.object({ session_id: z.string().min(1) });
const REGEX_SPECIAL_RE = /[.+^${}()|[\]\\]/g;

/** PLAN, and the first agent step of a run, start from a clean workspace. */
export function isFreshLoopRequest(body: StepRequestBody): boolean {
  return (
    body.command === LoopCommand.Plan ||
    (body.command === LoopCommand.Step && body.step?.fresh === true)
  );
}

/** A step that commits and pushes its changes, like EXECUTE. */
export function isPushingStep(body: StepRequestBody): boolean {
  return (
    body.command === LoopCommand.Step &&
    body.step?.finish === LoopStepFinish.Push
  );
}

/**
 * The part of the workspace CLAUDE.md a step adds: the toolkit's own
 * instructions and how the run expects the agent to behave unattended.
 */
export function buildStepWorkspaceInstructions(
  step: LoopStepConfig | undefined
): string | undefined {
  if (!step) {
    return;
  }
  const lines = [
    `## Process step: ${step.name}`,
    "",
    "You run unattended as one step of an automated process. Nobody can answer",
    "an interactive question while you work.",
    `- The issue this run works on is in \`${LOOP_STEP_WORK_DIR}/${LoopStepFile.Issue}\`.`,
    "- Work from this workspace root; change code inside the repositories below.",
  ];
  if (step.askQuestions) {
    lines.push(
      `- When you need a decision from the developer, do not guess: write the questions to \`${LOOP_STEP_WORK_DIR}/${LoopStepFile.Questions}\` as a JSON array of \`{"id": "q1", "question": "...", "options": ["..."]}\` (options optional), then stop. The run resumes this session with the answers.`,
      `- Limits of that file: at most ${LOOP_STEP_QUESTIONS_MAX} questions; each question at most ${LOOP_STEP_QUESTION_MAX} characters; at most ${LOOP_STEP_OPTIONS_MAX} options per question, each at most ${LOOP_STEP_OPTION_MAX} characters (keep options short, put the reasoning in the question).`
    );
  } else {
    lines.push(
      "- Do not stop to ask questions: make the most reasonable choice and note it."
    );
  }
  if (step.finish === LoopStepFinish.Push) {
    lines.push(
      "- Leave your changes in the repositories; they are committed and pushed when you finish.",
      "- Do not push, open pull requests or call the Git host's API yourself: the workflow's actions open the pull requests."
    );
  } else {
    lines.push("- Do not commit or push; a later step does.");
  }
  const toolkit = step.toolkit?.instructions.trim();
  if (toolkit) {
    lines.push("", "### Toolkit", "", toolkit);
  }
  return lines.join("\n");
}

/**
 * Before the agent starts: clear the previous step's outputs from the shared
 * work directory, write the step's settings and the Issue, and link the
 * toolkit's directories into the workspace root.
 */
export async function prepareLoopStep(input: {
  step: LoopStepConfig;
  workspaceRoot: string;
  claudeWorkDir: string;
  artifacts: readonly StepArtifact[];
  repos: readonly StepRepository[];
  log: (message: string) => void;
}): Promise<void> {
  const { claudeWorkDir } = input;
  await Promise.all(
    PREVIOUS_STEP_FILES.map((file) =>
      fs.rm(path.join(claudeWorkDir, file), { force: true })
    )
  );
  await fs.writeFile(
    path.join(claudeWorkDir, LoopStepFile.Request),
    `${JSON.stringify(input.step, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(claudeWorkDir, LoopStepFile.Issue),
    issueMarkdown(input.artifacts),
    "utf8"
  );
  if (input.step.toolkit) {
    await mountToolkit(
      input.step.toolkit,
      input.workspaceRoot,
      input.repos,
      input.log
    );
  }
}

/**
 * The agent command of a step. An instruction that starts with a slash
 * command (a toolkit skill or command) is passed as the prompt argument so
 * Claude Code expands it; anything else, and a resumed session's answers,
 * goes through stdin.
 */
export async function buildStepLaunch(input: {
  body: StepRequestBody;
  runtime: SupportedRuntimeSelection;
  /** `-p` and the shared flags, without a prompt. */
  baseClaudeArgs: readonly string[];
  /** `-p -` and the shared flags (prompt on stdin). */
  stdinClaudeArgs: readonly string[];
  claudeWorkDir: string;
  harnessBin: string;
}): Promise<{ cmd: string; args: string[] }> {
  const prompt = input.body.prompt?.trim() ?? "";
  const resume = input.body.parentSessionId
    ? ["--resume", input.body.parentSessionId]
    : [];
  if (
    prompt.startsWith("/") &&
    input.runtime.harness.adapter.harness === LoopHarness.Claude
  ) {
    return buildClaudePipeline(
      [...input.baseClaudeArgs, ...resume, prompt],
      input.claudeWorkDir,
      input.harnessBin
    );
  }
  const promptFile = path.join(input.claudeWorkDir, "step-prompt.txt");
  await fs.writeFile(promptFile, prompt, "utf8");
  return buildNativePromptPipeline(
    input.runtime,
    [...input.stdinClaudeArgs, ...resume],
    input.claudeWorkDir,
    input.harnessBin,
    promptFile
  );
}

/**
 * What a finished step produced, as uploaded artifacts: its questions and the
 * files matching its artifact globs (`step`), and the execution result of a
 * pushing step. Also records the agent's session id (session-id.txt) from
 * its output, so the run can resume the session with the answers.
 */
export function readStepOutputs(
  claudeWorkDir: string
): Record<string, unknown> {
  const step = readStepRequest(claudeWorkDir);
  if (!step) {
    return {};
  }
  recordStepSessionId(claudeWorkDir);
  const workspaceRoot = path.resolve(claudeWorkDir, "..", "..");
  const questions = readStepQuestions(claudeWorkDir);
  const result: LoopStepResult = {
    stepId: step.stepId,
    questions: questions.questions,
    files: collectStepFiles(workspaceRoot, step.artifacts),
    questionsError: questions.error,
  };
  const executionResult = readJsonFile(
    path.join(claudeWorkDir, LoopArtifactFile.ExecutionResult)
  );
  return {
    [LOOP_STEP_ARTIFACT_KEY]: result,
    ...(executionResult === null ? {} : { executionResult }),
  };
}

/** Files matching `globs` (relative to `root`), within the size limits. */
export function collectStepFiles(
  root: string,
  globs: readonly string[]
): LoopStepCollectedFile[] {
  const matched = new Set<string>();
  for (const glob of globs) {
    const pattern = globToRegExp(glob);
    const base = staticGlobBase(glob);
    walkFiles(root, base, (relative) => {
      if (pattern.test(relative)) {
        matched.add(relative);
      }
    });
  }
  const files: LoopStepCollectedFile[] = [];
  let totalBytes = 0;
  for (const relative of [...matched].sort()) {
    if (
      files.length >= LOOP_STEP_FILES_MAX ||
      totalBytes >= LOOP_STEP_FILES_TOTAL_BYTES_MAX
    ) {
      break;
    }
    const content = readTextOrNull(path.join(root, relative));
    if (content === null) {
      continue;
    }
    const limit = Math.min(
      LOOP_STEP_FILE_BYTES_MAX,
      LOOP_STEP_FILES_TOTAL_BYTES_MAX - totalBytes
    );
    const truncated = content.length > limit;
    const kept = truncated ? content.slice(0, limit) : content;
    totalBytes += kept.length;
    files.push({ path: relative, content: kept, truncated });
  }
  return files;
}

/** `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += (char ?? "").replace(REGEX_SPECIAL_RE, String.raw`\$&`);
    }
  }
  return new RegExp(`^${source}$`);
}

function readStepRequest(claudeWorkDir: string): LoopStepConfig | null {
  const parsed = LoopStepConfigSchema.safeParse(
    readJsonFile(path.join(claudeWorkDir, LoopStepFile.Request))
  );
  return parsed.success ? parsed.data : null;
}

function readStepQuestions(claudeWorkDir: string): {
  questions: LoopStepQuestion[];
  error: string | null;
} {
  const file = path.join(claudeWorkDir, LoopStepFile.Questions);
  if (!existsSync(file)) {
    return { questions: [], error: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { questions: [], error: boundedError(`not JSON: ${String(error)}`) };
  }
  const parsed = questionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      questions: [],
      error: boundedError(parsed.error.issues[0]?.message ?? "invalid"),
    };
  }
  return { questions: parsed.data, error: null };
}

/** session-id.txt from the agent's stream output, when no one wrote it. */
function recordStepSessionId(claudeWorkDir: string): void {
  const sessionFile = path.join(claudeWorkDir, SESSION_ID_FILE);
  if (existsSync(sessionFile)) {
    return;
  }
  const output = readTextOrNull(path.join(claudeWorkDir, CLAUDE_OUTPUT_FILE));
  const sessionId = output ? lastSessionId(output) : null;
  if (sessionId) {
    try {
      writeFileSync(sessionFile, `${sessionId}\n`, "utf8");
    } catch {
      // Best effort: without it the answers start a new session.
    }
  }
}

function lastSessionId(output: string): string | null {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) {
      continue;
    }
    const event = sessionEventSchema.safeParse(parseJsonOrNull(line));
    if (event.success) {
      return event.data.session_id;
    }
  }
  return null;
}

function issueMarkdown(artifacts: readonly StepArtifact[]): string {
  const issues = artifacts.filter(
    (artifact) => artifact.type === LoopArtifactType.Feature
  );
  const chosen = issues.length > 0 ? issues : artifacts.slice(0, 1);
  return `${chosen
    .map((artifact) => `# ${artifact.title}\n\n${artifact.content.trim()}\n`)
    .join("\n")}`;
}

async function mountToolkit(
  toolkit: LoopStepToolkit,
  workspaceRoot: string,
  repos: readonly StepRepository[],
  log: (message: string) => void
): Promise<void> {
  const wanted = toolkit.repository.toLowerCase();
  const repo = repos.find((entry) => entry.fullName?.toLowerCase() === wanted);
  if (!repo) {
    throw new Error(
      `The toolkit repository ${toolkit.repository} is not in the loop workspace`
    );
  }
  for (const mount of toolkit.mounts) {
    const source = resolveInside(repo.dir, mount);
    const target = resolveInside(workspaceRoot, mount);
    if (!(source && target && existsSync(source))) {
      log(
        `Toolkit path ${mount} was not found in ${toolkit.repository}; skipped`
      );
      continue;
    }
    await linkInto(source, target);
  }
}

/**
 * Links `source` at `target`. A directory that already exists in the
 * workspace (e.g. `.claude` with the project's agents) keeps its own entries
 * and gets the toolkit's entries linked into it.
 */
async function linkInto(source: string, target: string): Promise<void> {
  const existing = lstatOrNull(target);
  const sourceIsDir = lstatOrNull(source)?.isDirectory() === true;
  if (existing?.isSymbolicLink()) {
    await fs.unlink(target);
  } else if (existing?.isDirectory() && sourceIsDir) {
    for (const entry of await fs.readdir(source)) {
      await linkInto(path.join(source, entry), path.join(target, entry));
    }
    return;
  } else if (existing) {
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(source, target, sourceIsDir ? "junction" : "file");
}

function resolveInside(base: string, relative: string): string | null {
  const resolved = path.resolve(base, relative);
  const root = path.resolve(base);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

/** The directory before the first wildcard segment ("" for the root). */
function staticGlobBase(glob: string): string {
  const segments = glob.split("/");
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (GLOB_SPECIAL_RE.test(segment)) {
      break;
    }
    fixed.push(segment);
  }
  return fixed.join("/");
}

/** Calls `onFile` with each regular file under `root/base` (POSIX relative paths). */
function walkFiles(
  root: string,
  base: string,
  onFile: (relative: string) => void
): void {
  let visited = 0;
  const visit = (relativeDir: string, depth: number): void => {
    if (depth > WALK_DEPTH_MAX) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(root, relativeDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > WALK_ENTRIES_MAX) {
        return;
      }
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        visit(relative, depth + 1);
      } else if (entry.isFile()) {
        onFile(relative);
      }
    }
  };
  visit(base, 0);
}

function readJsonFile(file: string): unknown | null {
  const text = readTextOrNull(file);
  return text === null ? null : parseJsonOrNull(text);
}

function parseJsonOrNull(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

function boundedError(message: string): string {
  return message.slice(0, QUESTIONS_ERROR_MAX);
}
