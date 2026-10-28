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
  LOOP_STEP_ATTACH_FILE_BYTES_MAX,
  LOOP_STEP_ATTACH_FILES_MAX,
  LOOP_STEP_ATTACH_TOTAL_BYTES_MAX,
  LOOP_STEP_FILE_BYTES_MAX,
  LOOP_STEP_FILES_MAX,
  LOOP_STEP_FILES_TOTAL_BYTES_MAX,
  LOOP_STEP_INPUTS_DIR,
  LOOP_STEP_OPTION_MAX,
  LOOP_STEP_OPTIONS_MAX,
  LOOP_STEP_QUESTION_MAX,
  LOOP_STEP_QUESTIONS_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepAttachment,
  type LoopStepCollectedFile,
  type LoopStepConfig,
  LoopStepConfigSchema,
  LoopStepFile,
  LoopStepFinish,
  type LoopStepInputFile,
  type LoopStepQuestion,
  LoopStepQuestionsFileSchema,
  type LoopStepResult,
  LoopStepRole,
  type LoopStepToolkit,
} from "@agentflow-ai/loops-api/loop-step";
import {
  INTEGRATION_MCP_SERVER_NAME,
  type IntegrationSessionGrant,
} from "@repo/api/src/types/integration-tools";
import { z } from "zod";
import { CLAUDE_OUTPUT_SIDECAR_FILE } from "../../main/cost/token-usage.js";
import {
  buildClaudePipeline,
  buildNativePromptPipeline,
  type SupportedRuntimeSelection,
} from "./harness-pipeline.js";
import {
  integrationMcpConfig,
  integrationToolEnv,
  openLoopIntegrationSession,
  writeAttachHelper,
} from "./integration-session-client.js";
import {
  collectPersonalStepFiles,
  type PersonalRunnerProject,
  personalStepInstructions,
  personalStepWorkspaceRoot,
} from "./personal-runner.js";

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
  loopId?: string;
  agentFlowAuthToken?: string;
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
  "integration-mcp-config.json",
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
  lines.push(...roleInstructions(step));
  const toolkit = step.toolkit?.instructions.trim();
  if (toolkit) {
    lines.push("", "### Toolkit", "", toolkit);
  }
  return lines.join("\n");
}

/**
 * Before the agent starts: clear the previous step's outputs from the shared
 * work directory, start the step's own output, write the step's settings and
 * the Issue, and link the toolkit's directories into the workspace root.
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
  await removePreviousAttachFiles(
    input.step,
    input.workspaceRoot,
    claudeWorkDir
  );
  // An empty sidecar, as run-loop.sh writes when a run starts: the step's
  // usage and outcome are read from its own claude-output.jsonl, not from the
  // stream a PLAN or EXECUTE loop of this work directory archived.
  await fs.writeFile(
    path.join(claudeWorkDir, CLAUDE_OUTPUT_SIDECAR_FILE),
    "",
    "utf8"
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
  await writeStepInputs(claudeWorkDir, input.step.inputs ?? [], input.log);
  if (input.step.role === LoopStepRole.Implement) {
    await writeApprovedPlan(claudeWorkDir, input.artifacts, input.log);
  }
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
 * goes through stdin. A step whose grant gives its agent integration tools
 * gets them (prepareStepIntegrationTools); `env` holds their token.
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
  /** The API the loop reports to: its integration session comes from there. */
  apiBaseUrl: string;
  openSession?: typeof openLoopIntegrationSession;
  /**
   * The personal runner's project, on a personal runner: the step's
   * instructions go to the system prompt (nothing is written into the
   * person's project folder), its agent uses this computer's own tools
   * instead of AgentFlow's integration tools (which act with the
   * connection's credentials), and skips permission prompts when the person
   * chose so.
   */
  personal?: PersonalRunnerProject | null;
}): Promise<{ cmd: string; args: string[]; env: Record<string, string> }> {
  const step = input.body.step;
  const tools = await prepareStepIntegrationTools({
    step: input.personal ? undefined : step,
    claudeWorkDir: input.claudeWorkDir,
    openSession: () =>
      (input.openSession ?? openLoopIntegrationSession)({
        apiBaseUrl: input.apiBaseUrl,
        loopId: input.body.loopId ?? "",
        token: input.body.agentFlowAuthToken ?? "",
      }),
    mcpConfig: integrationMcpConfig,
  });
  const systemPrompt =
    input.personal &&
    step &&
    input.runtime.harness.adapter.harness === LoopHarness.Claude
      ? [
          "--append-system-prompt",
          personalStepInstructions(
            step,
            input.claudeWorkDir,
            roleInstructions(step, input.claudeWorkDir)
          ),
          ...(input.personal.skipPermissions
            ? ["--permission-mode", "bypassPermissions"]
            : []),
        ]
      : [];
  const readOnly = readOnlyStepArgs(step);
  const baseClaudeArgs = [
    ...withIntegrationToolArgs(input.baseClaudeArgs, tools),
    ...systemPrompt,
    ...readOnly,
  ];
  const stdinClaudeArgs = [
    ...withIntegrationToolArgs(input.stdinClaudeArgs, tools),
    ...systemPrompt,
    ...readOnly,
  ];
  const prompt = input.body.prompt?.trim() ?? "";
  const resume = resumeArgs(input.body);
  if (
    prompt.startsWith("/") &&
    input.runtime.harness.adapter.harness === LoopHarness.Claude
  ) {
    // `--` ends the options: `--mcp-config` (added for integration tools)
    // takes several values and would read the prompt as a config file.
    return {
      ...buildClaudePipeline(
        [...baseClaudeArgs, ...resume, "--", prompt],
        input.claudeWorkDir,
        input.harnessBin
      ),
      env: tools.env,
    };
  }
  const promptFile = path.join(input.claudeWorkDir, "step-prompt.txt");
  await fs.writeFile(promptFile, prompt, "utf8");
  return {
    ...buildNativePromptPipeline(
      input.runtime,
      [...stdinClaudeArgs, ...resume],
      input.claudeWorkDir,
      input.harnessBin,
      promptFile
    ),
    env: tools.env,
  };
}

/** What a step's agent gets for its integration tools. */
export type StepIntegrationTools = {
  /** `--mcp-config <file>`, added to the Claude args. */
  args: string[];
  /** The session token, for the agent's environment only. */
  env: Record<string, string>;
};

/**
 * The integration tools of a step whose grant gives the agent some
 * (`step.integrationTools`): the loop's session token, an MCP config naming
 * only the AgentFlow integration tools (token read from the environment) in
 * the work directory, and the args that load it. Other MCP servers the loop
 * uses stay (no `--strict-mcp-config`): the runner is isolated already.
 * Throws when the session cannot be opened, so the loop fails instead of
 * running without the writes its step was granted.
 */
export async function prepareStepIntegrationTools(input: {
  step: LoopStepConfig | undefined;
  claudeWorkDir: string;
  openSession: () => Promise<IntegrationSessionGrant>;
  mcpConfig: (mcpUrl: string) => object;
}): Promise<StepIntegrationTools> {
  if (!input.step?.integrationTools) {
    return { args: [], env: {} };
  }
  let grant: IntegrationSessionGrant;
  try {
    grant = await input.openSession();
  } catch (error) {
    throw new Error(
      `The step's integration tools could not be opened: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const file = path.join(input.claudeWorkDir, STEP_MCP_CONFIG_FILE);
  await fs.writeFile(
    file,
    `${JSON.stringify(input.mcpConfig(grant.mcpUrl), null, 2)}\n`,
    "utf8"
  );
  const attachHelper = grant.filesUrl
    ? await writeAttachHelper(input.claudeWorkDir)
    : null;
  return {
    args: ["--mcp-config", file],
    env: integrationToolEnv(grant, attachHelper),
  };
}

/** The Claude args with the integration tools added to `--allowedTools`. */
export function withIntegrationToolArgs(
  claudeArgs: readonly string[],
  tools: StepIntegrationTools
): string[] {
  if (tools.args.length === 0) {
    return [...claudeArgs];
  }
  const allowedAt = claudeArgs.indexOf("--allowedTools") + 1;
  return [
    ...claudeArgs.map((arg, index) =>
      index === allowedAt && allowedAt > 0
        ? `${arg},mcp__${INTEGRATION_MCP_SERVER_NAME}`
        : arg
    ),
    ...tools.args,
  ];
}

export const STEP_MCP_CONFIG_FILE = "integration-mcp-config.json";

/**
 * What a read-only step may not do: edit files, commit or push. Deny rules
 * win over every allow rule and permission mode. Write stays, for the
 * step's answer file.
 */
export const READ_ONLY_STEP_DISALLOWED_TOOLS = [
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash(git commit:*)",
  "Bash(git push:*)",
].join(",");

export function readOnlyStepArgs(step: LoopStepConfig | undefined): string[] {
  return step?.readOnly
    ? [`--disallowedTools=${READ_ONLY_STEP_DISALLOWED_TOOLS}`]
    : [];
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
  const personalRoot = personalStepWorkspaceRoot(claudeWorkDir);
  const workspaceRoot = personalRoot ?? path.resolve(claudeWorkDir, "..", "..");
  const questions = readStepQuestions(claudeWorkDir);
  const result: LoopStepResult = {
    stepId: step.stepId,
    questions: questions.questions,
    files: personalRoot
      ? collectPersonalStepFiles({
          projectDir: personalRoot,
          claudeWorkDir,
          globs: step.artifacts,
          collect: collectStepFiles,
        })
      : collectStepFiles(workspaceRoot, step.artifacts),
    questionsError: questions.error,
  };
  if (step.attach?.length) {
    const collected = buildStepAttachments(
      personalRoot
        ? collectPersonalStepFiles({
            projectDir: personalRoot,
            claudeWorkDir,
            globs: step.attach,
            collect: (root, globs) =>
              matchStepFiles(root, globs).map((p) => ({
                path: p,
                file: path.join(root, p),
              })),
          })
        : matchStepFiles(workspaceRoot, step.attach).map((p) => ({
            path: p,
            file: path.join(workspaceRoot, p),
          }))
    );
    result.attachments = collected.attachments;
    if (collected.omitted > 0) {
      result.attachmentsOmitted = collected.omitted;
    }
  }
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
  const matched = matchStepFiles(root, globs);
  const files: LoopStepCollectedFile[] = [];
  let totalBytes = 0;
  for (const relative of matched) {
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

/** Regular files under `root` matching `globs`, as sorted POSIX relative paths. */
export function matchStepFiles(
  root: string,
  globs: readonly string[]
): string[] {
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
  return [...matched].sort();
}

/**
 * Reads the files an `attach` step leaves as bytes (base64), within the attach
 * limits. `path` is reported, `file` is read. A file over a limit is listed as
 * skipped; matches beyond the count limit are only counted.
 */
export function buildStepAttachments(
  entries: ReadonlyArray<{ path: string; file: string }>
): { attachments: LoopStepAttachment[]; omitted: number } {
  const attachments: LoopStepAttachment[] = [];
  let omitted = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const stat = lstatOrNull(entry.file);
    if (!stat?.isFile()) {
      continue;
    }
    if (attachments.length >= LOOP_STEP_ATTACH_FILES_MAX) {
      omitted += 1;
      continue;
    }
    const skipped = attachmentSkipReason(stat.size, totalBytes);
    if (skipped) {
      attachments.push({ path: entry.path, size: stat.size, skipped });
      continue;
    }
    totalBytes += stat.size;
    attachments.push({
      path: entry.path,
      size: stat.size,
      data: readFileSync(entry.file).toString("base64"),
    });
  }
  return { attachments, omitted };
}

function attachmentSkipReason(size: number, totalBytes: number): string | null {
  if (size > LOOP_STEP_ATTACH_FILE_BYTES_MAX) {
    return `larger than ${LOOP_STEP_ATTACH_FILE_BYTES_MAX / (1024 * 1024)} MB`;
  }
  if (totalBytes + size > LOOP_STEP_ATTACH_TOTAL_BYTES_MAX) {
    return `over the ${LOOP_STEP_ATTACH_TOTAL_BYTES_MAX / (1024 * 1024)} MB of all attached files`;
  }
  return null;
}

/**
 * Replaces the work directory's input directory with the step's input files
 * (an orchestrator task's files from earlier tasks).
 */
async function writeStepInputs(
  claudeWorkDir: string,
  inputs: readonly LoopStepInputFile[],
  log: (message: string) => void
): Promise<void> {
  const dir = path.join(claudeWorkDir, LOOP_STEP_INPUTS_DIR);
  await fs.rm(dir, { recursive: true, force: true });
  if (inputs.length === 0) {
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  for (const input of inputs) {
    const target = resolveInside(dir, input.name);
    if (!target) {
      log(`Skipped input file with an unsafe name: ${input.name}`);
      continue;
    }
    await fs.writeFile(target, input.content, "utf8");
  }
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

/**
 * session-id.txt from the agent's stream output, when no one wrote it: the
 * answers to a step's questions, and the retry of a failed step, resume it.
 */
export function recordStepSessionId(claudeWorkDir: string): void {
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
  const chosen = sourceArtifacts(artifacts);
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

/**
 * The item the run works on: its Issue, else its PRD, else the first
 * artifact that is not the plan (a loop on the plan also gets its source).
 */
function sourceArtifacts(
  artifacts: readonly StepArtifact[]
): readonly StepArtifact[] {
  for (const type of [LoopArtifactType.Feature, LoopArtifactType.Prd]) {
    const matching = artifacts.filter((artifact) => artifact.type === type);
    if (matching.length > 0) {
      return matching;
    }
  }
  const other = artifacts.find(
    (artifact) => artifact.type !== LoopArtifactType.ImplementationPlan
  );
  return other ? [other] : artifacts.slice(0, 1);
}

/**
 * What a step's role adds to its CLAUDE.md section (docs/workflows.md "Step
 * roles"), or to a personal runner's system prompt with the run's own work
 * directory (`workDir`).
 */
function roleInstructions(
  step: LoopStepConfig,
  workDir: string = LOOP_STEP_WORK_DIR
): string[] {
  const plan = `${workDir}/${LoopStepFile.Plan}`;
  if (step.role === LoopStepRole.Plan) {
    return [
      "",
      "### Plan step",
      "",
      `- This step writes the run's implementation plan. When the plan is final, write it to \`${plan}\` as markdown, also when your tools wrote it elsewhere (copy it there). AgentFlow keeps that file as the run's Implementation Plan; the step fails without it.`,
      "- The plan gives a short summary, the changes per repository, the ordered tasks as a `- [ ]` checklist, the risks, and the open questions if any.",
      `- When \`${plan}\` already exists (an earlier round), update it rather than starting over.`,
    ];
  }
  if (step.role !== LoopStepRole.Implement) {
    return [];
  }
  const lines = [
    "",
    "### Implement step",
    "",
    `- The approved implementation plan is \`${plan}\`. Implement it in the repositories; do not change that file.`,
  ];
  if (step.releaseNotes) {
    lines.push(
      `- When the work is done, write release notes to \`${workDir}/${LoopStepFile.ReleaseNotes}\` as markdown for the people who use and review the change: what changed and why, per repository when several changed, and notable risks or follow-ups. No file lists.`
    );
  }
  return lines;
}

/** The approved plan (the loop's plan document) where an implement step reads it. */
async function writeApprovedPlan(
  claudeWorkDir: string,
  artifacts: readonly StepArtifact[],
  log: (message: string) => void
): Promise<void> {
  const plan = artifacts.find(
    (artifact) => artifact.type === LoopArtifactType.ImplementationPlan
  );
  if (!plan?.content.trim()) {
    log("The implement step got no approved plan; it reads none");
    return;
  }
  await fs.writeFile(
    path.join(claudeWorkDir, LoopStepFile.Plan),
    `${plan.content.trim()}\n`,
    "utf8"
  );
}

/** `--resume` of the parent loop's session, forked when the step asks for it. */
function resumeArgs(body: StepRequestBody): string[] {
  if (!body.parentSessionId) {
    return [];
  }
  return body.step?.forkSession
    ? ["--resume", body.parentSessionId, "--fork-session"]
    : ["--resume", body.parentSessionId];
}

/**
 * Removes files an earlier task of the case left that match the step's
 * `attach` globs, so the step only collects what it writes itself. The
 * personal runner's per-run work dir needs no cleanup.
 */
async function removePreviousAttachFiles(
  step: LoopStepConfig,
  workspaceRoot: string,
  claudeWorkDir: string
): Promise<void> {
  if (!step.attach?.length || personalStepWorkspaceRoot(claudeWorkDir)) {
    return;
  }
  await Promise.all(
    matchStepFiles(workspaceRoot, step.attach).map((relative) =>
      fs.rm(path.join(workspaceRoot, relative), { force: true })
    )
  );
}
