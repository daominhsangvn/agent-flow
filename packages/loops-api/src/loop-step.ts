import { z } from "zod";
import { LoopArtifactFile } from "./artifacts";

/**
 * STEP loops: one step of a project process (a toolkit command or any other
 * instruction) run by the agent in the loop workspace. The dispatcher sends
 * the step's settings with the loop (`LoopRequestBody.step`); the computer
 * writes them to the work directory (`LoopStepFile.Request`) so the live exit
 * and boot recovery read the step's outputs the same way, and uploads what
 * the step produced under `LOOP_STEP_ARTIFACT_KEY`.
 */

/** What the step does with its changes when it ends. */
export const LoopStepFinish = {
  None: "none",
  /** Commit and push every repository with changes (execution-result.json). */
  Push: "push",
} as const;
export type LoopStepFinish =
  (typeof LoopStepFinish)[keyof typeof LoopStepFinish];

/**
 * What a step is to AgentFlow (docs/workflows.md "Step roles"). A plan step
 * writes the run's implementation plan; an implement step works from the
 * approved plan, pushes and writes release notes. The computer adds the
 * role's contract to the workspace CLAUDE.md.
 */
export const LoopStepRole = {
  Plan: "plan",
  Implement: "implement",
} as const;
export type LoopStepRole = (typeof LoopStepRole)[keyof typeof LoopStepRole];

/** Files of a STEP loop in its work directory (`.agentflow-ai/work`). */
export const LoopStepFile = {
  /** The step's settings, written by the computer before the agent starts. */
  Request: "step-request.json",
  /** Questions the agent asks the developer instead of guessing. */
  Questions: "questions.json",
  /** The source item (issue) the run works on, as markdown. */
  Issue: "issue.md",
  /**
   * The run's implementation plan: written by a plan step, and the approved
   * plan an implement step works from (written by the computer first).
   */
  Plan: LoopArtifactFile.PlanMarkdown,
  /** Release notes an implement step writes when it is done. */
  ReleaseNotes: LoopArtifactFile.ReleaseNotes,
} as const;
export type LoopStepFile = (typeof LoopStepFile)[keyof typeof LoopStepFile];

/** The work directory of a loop, relative to its workspace root. */
export const LOOP_STEP_WORK_DIR = ".agentflow-ai/work";

/** Key of the step's outputs in the loop's uploaded artifacts. */
export const LOOP_STEP_ARTIFACT_KEY = "step";

export const LOOP_STEP_PATHS_MAX = 20;
export const LOOP_STEP_QUESTIONS_MAX = 30;
export const LOOP_STEP_QUESTION_MAX = 2000;
export const LOOP_STEP_OPTIONS_MAX = 10;
/** Longest option of a question. */
export const LOOP_STEP_OPTION_MAX = 500;
/** Files collected from the step's artifact globs. */
export const LOOP_STEP_FILES_MAX = 20;
/** Bytes kept of one collected file; the rest is cut (`truncated`). */
export const LOOP_STEP_FILE_BYTES_MAX = 200_000;
/** Bytes of all collected files together. */
export const LOOP_STEP_FILES_TOTAL_BYTES_MAX = 1_000_000;
export const LOOP_STEP_TOOLKIT_INSTRUCTIONS_MAX = 16_000;
/** Files a step may leave for its item (`attach`). */
export const LOOP_STEP_ATTACH_FILES_MAX = 20;
/** Bytes of one attached file; a larger one is listed as skipped. */
export const LOOP_STEP_ATTACH_FILE_BYTES_MAX = 4 * 1024 * 1024;
/** Bytes of all attached files together; with base64 the upload stays under the API proxy's 10 MB body limit. */
export const LOOP_STEP_ATTACH_TOTAL_BYTES_MAX = 5 * 1024 * 1024;
/** Input files a step may be given. */
export const LOOP_STEP_INPUTS_MAX = 5;
/** Characters of all input files together. */
export const LOOP_STEP_INPUTS_TOTAL_BYTES_MAX = 400_000;
/** The directory of the work directory that holds a step's input files. */
export const LOOP_STEP_INPUTS_DIR = "inputs";

/** A path relative to the workspace root (no leading slash, no `..`). */
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;
const relativePathSchema = z.string().min(1).max(200).regex(RELATIVE_PATH_RE);

/** A bare file name (no directory, not `.` or `..`). */
const INPUT_NAME_RE = /^(?!\.{1,2}$)[\w.-]{1,200}$/;

export const LoopStepInputFileSchema = z.object({
  name: z.string().regex(INPUT_NAME_RE),
  content: z.string().max(LOOP_STEP_FILE_BYTES_MAX),
});
export type LoopStepInputFile = z.infer<typeof LoopStepInputFileSchema>;

export const LoopStepToolkitSchema = z.object({
  /** Full name of the project repository that holds the toolkit. */
  repository: z.string().min(3).max(256),
  /** Directories of that repository linked into the workspace root. */
  mounts: z.array(relativePathSchema).min(1).max(LOOP_STEP_PATHS_MAX),
  /** Added to the workspace CLAUDE.md. */
  instructions: z.string().max(LOOP_STEP_TOOLKIT_INSTRUCTIONS_MAX),
});
export type LoopStepToolkit = z.infer<typeof LoopStepToolkitSchema>;

export const LoopStepConfigSchema = z.object({
  /** Workflow run the step belongs to. */
  runId: z.string().min(1).max(64),
  stepId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  /**
   * The run's first agent step: the workspace starts clean (no work files or
   * worktrees left by an earlier run of the same item). Later steps continue
   * the same worktrees.
   */
  fresh: z.boolean(),
  /** The agent may stop with questions (`LoopStepFile.Questions`). */
  askQuestions: z.boolean(),
  /** Globs from the workspace root collected once the step ends. */
  artifacts: z.array(relativePathSchema).max(LOOP_STEP_PATHS_MAX),
  finish: z.enum(LoopStepFinish),
  toolkit: LoopStepToolkitSchema.nullable(),
  /**
   * The step's `connections:` grant gives the agent integration tools: the
   * computer exchanges the loop for a session token and hands the agent the
   * AgentFlow MCP server (docs/workflows.md "Integration tools"). Absent:
   * none (also every step stored before integration tools).
   */
  integrationTools: z.boolean().optional(),
  /** The step's role; absent for a step without one (and steps stored before roles). */
  role: z.enum(LoopStepRole).optional(),
  /** An implement step writes release notes (`LoopStepFile.ReleaseNotes`). */
  releaseNotes: z.boolean().optional(),
  /**
   * The loop resumes its parent loop's session in a new session forked from
   * it (`--resume <session> --fork-session`): the retry of a failed step goes
   * on from where it stopped and leaves the failed session as it was.
   */
  forkSession: z.boolean().optional(),
  /**
   * The agent reads and answers: editing files, committing and pushing are
   * denied (an orchestrator task whose command is a read). It may still
   * write its answer file.
   */
  readOnly: z.boolean().optional(),
  /**
   * Globs from the workspace root of files the step leaves for its item,
   * collected as bytes once it ends (`LoopStepResult.attachments`). Any type,
   * within the attach limits.
   */
  attach: z.array(relativePathSchema).max(LOOP_STEP_PATHS_MAX).optional(),
  /**
   * Text files written to `<work dir>/inputs/` before the agent starts (an
   * orchestrator task's files from earlier tasks).
   */
  inputs: z.array(LoopStepInputFileSchema).max(LOOP_STEP_INPUTS_MAX).optional(),
});
export type LoopStepConfig = z.infer<typeof LoopStepConfigSchema>;

export const LoopStepQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(LOOP_STEP_QUESTION_MAX),
  options: z
    .array(z.string().min(1).max(LOOP_STEP_OPTION_MAX))
    .max(LOOP_STEP_OPTIONS_MAX)
    .optional(),
});
export type LoopStepQuestion = z.infer<typeof LoopStepQuestionSchema>;

/** What the agent writes to `LoopStepFile.Questions`. */
export const LoopStepQuestionsFileSchema = z
  .array(LoopStepQuestionSchema)
  .max(LOOP_STEP_QUESTIONS_MAX);

export const LoopStepCollectedFileSchema = z.object({
  /** Path relative to the workspace root. */
  path: z.string().min(1).max(500),
  content: z.string(),
  truncated: z.boolean(),
});
export type LoopStepCollectedFile = z.infer<typeof LoopStepCollectedFileSchema>;

/**
 * A file the step left for its item. `path` is relative to the workspace
 * root. `data` (base64) is sent only from the runner to the API, which
 * replaces it with `storageKey`. `skipped` says why it was not collected.
 */
export const LoopStepAttachmentSchema = z.object({
  path: z.string().min(1).max(500),
  size: z.number().int().nonnegative(),
  data: z.string().optional(),
  storageKey: z.string().min(1).max(1024).optional(),
  skipped: z.string().max(500).optional(),
});
export type LoopStepAttachment = z.infer<typeof LoopStepAttachmentSchema>;

/** The step's outputs, uploaded under `LOOP_STEP_ARTIFACT_KEY`. */
export const LoopStepResultSchema = z.object({
  stepId: z.string().min(1).max(64),
  questions: z.array(LoopStepQuestionSchema).max(LOOP_STEP_QUESTIONS_MAX),
  files: z.array(LoopStepCollectedFileSchema).max(LOOP_STEP_FILES_MAX),
  /** Set when questions.json was present but not valid. */
  questionsError: z.string().max(500).nullable(),
  attachments: z
    .array(LoopStepAttachmentSchema)
    .max(LOOP_STEP_ATTACH_FILES_MAX)
    .optional(),
  /** Matching files beyond the count limit. */
  attachmentsOmitted: z.number().int().nonnegative().optional(),
});
export type LoopStepResult = z.infer<typeof LoopStepResultSchema>;
