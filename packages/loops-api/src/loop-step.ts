import { z } from "zod";

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

/** Files of a STEP loop in its work directory (`.agentflow-ai/work`). */
export const LoopStepFile = {
  /** The step's settings, written by the computer before the agent starts. */
  Request: "step-request.json",
  /** Questions the agent asks the developer instead of guessing. */
  Questions: "questions.json",
  /** The source item (issue) the run works on, as markdown. */
  Issue: "issue.md",
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

/** A path relative to the workspace root (no leading slash, no `..`). */
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;
const relativePathSchema = z.string().min(1).max(200).regex(RELATIVE_PATH_RE);

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

/** The step's outputs, uploaded under `LOOP_STEP_ARTIFACT_KEY`. */
export const LoopStepResultSchema = z.object({
  stepId: z.string().min(1).max(64),
  questions: z.array(LoopStepQuestionSchema).max(LOOP_STEP_QUESTIONS_MAX),
  files: z.array(LoopStepCollectedFileSchema).max(LOOP_STEP_FILES_MAX),
  /** Set when questions.json was present but not valid. */
  questionsError: z.string().max(500).nullable(),
});
export type LoopStepResult = z.infer<typeof LoopStepResultSchema>;
