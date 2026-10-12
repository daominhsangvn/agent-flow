/**
 * @file plan-state-bundle.ts
 * @description The saved state of a plan: what its loops left in the work
 * directory (plan.json, state.json, the exploration files, reviews, ...) plus
 * `plan-state.json`, a summary of where the plan stands and which loops of it
 * ran before. Every PLAN, EXECUTE and REQUEST_CHANGES loop saves it when it
 * ends and the next loop of the plan restores it (plan-state-sync.ts), on
 * whatever computer it runs, so the plan's progress, next step and context
 * carry over from loop to loop.
 *
 * A bundle is gzipped JSON, `{ schemaVersion, manifest, files }`, with every
 * file base64-encoded. Runtime output (logs, Claude streams, pid and session
 * files, the per-loop config and prompts, learnings) and files that look like
 * secrets are never part of it.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { z } from "zod";

/** The plan summary inside the work directory and the bundle. */
export const PLAN_STATE_FILE = "plan-state.json";
/** The loops that work on a plan and carry its state. */
export const PLAN_STATE_COMMANDS: ReadonlySet<string> = new Set([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
]);

export const PlanPhase = {
  Started: "started",
  AwaitingAnswers: "awaiting-answers",
  Planned: "planned",
  Implementing: "implementing",
  Implemented: "implemented",
} as const;
export type PlanPhase = (typeof PlanPhase)[keyof typeof PlanPhase];

export const PlanNextStep = {
  Plan: "plan",
  AnswerQuestions: "answer-questions",
  Execute: "execute",
  ContinueExecution: "continue-execution",
  Review: "review",
} as const;
export type PlanNextStep = (typeof PlanNextStep)[keyof typeof PlanNextStep];

export const PlanLoopOutcome = {
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type PlanLoopOutcome =
  (typeof PlanLoopOutcome)[keyof typeof PlanLoopOutcome];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_HISTORY = 100;
/** Gunzip cap: base64 grows the files by a third, plus the JSON around them. */
const MAX_BUNDLE_JSON_BYTES = 96 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;

const STATE_DIR = ".agentflow-ai";
/** The only file of the work directory's own `.agentflow-ai` that is state. */
const KEPT_STATE_FILES = new Set([`${STATE_DIR}/imported-plan`]);
const EXCLUDED_DIRS = new Set([
  ".learnings",
  ".tool-calls",
  ".git",
  "node_modules",
]);
const EXCLUDED_FILES = new Set([
  "process.pid",
  "session-id.txt",
  "claude-output.name.txt",
  "perf.jsonl",
  "prompt.md",
]);
const EXCLUDED_FILE_RES = [
  /^claude-output.*\.jsonl$/,
  /\.log$/,
  /-prompt\.txt$/,
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/,
  /^credentials/i,
];

const historyEntrySchema = z.object({
  loopId: z.string(),
  command: z.string(),
  outcome: z.string(),
  savedAt: z.string(),
  phase: z.string(),
});

export const planStateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  loopId: z.string().min(1),
  command: z.string(),
  outcome: z.enum(PlanLoopOutcome),
  savedAt: z.string(),
  /** The commit the plan was made at (`.plan-base`), when known. */
  baseCommit: z.string().nullable(),
  phase: z.enum(PlanPhase),
  nextStep: z.enum(PlanNextStep),
  progress: z.object({
    tasksTotal: z.number().int(),
    tasksDone: z.number().int(),
    openQuestions: z.number().int(),
    answeredQuestions: z.number().int(),
  }),
  /** Every loop of the plan so far, oldest first; the last one is this loop. */
  history: z.array(historyEntrySchema).max(MAX_HISTORY),
  /** Files left out for their size. */
  skipped: z.array(z.string()),
});
export type PlanStateManifest = z.infer<typeof planStateManifestSchema>;

export type PlanStateFile = { path: string; data: Buffer };
export type PlanStateBundle = {
  manifest: PlanStateManifest;
  files: PlanStateFile[];
};

const bundleSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: planStateManifestSchema,
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(MAX_PATH_LENGTH)
          .refine(
            (value) => isSafeRelativePath(value) && isPlanStatePath(value)
          ),
        data: z.string(),
      })
    )
    .max(MAX_FILES + 1),
});

const planSummarySchema = z.object({
  pendingTasks: z.array(z.unknown()).catch([]),
  completedTasks: z.array(z.unknown()).catch([]),
  openQuestions: z.array(z.unknown()).catch([]),
  answeredQuestions: z.array(z.unknown()).catch([]),
});

/** Whether a work-directory path (POSIX, relative) belongs to the plan state. */
export function isPlanStatePath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments[0] === STATE_DIR) {
    return KEPT_STATE_FILES.has(relPath);
  }
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) {
    return false;
  }
  const name = segments.at(-1) ?? "";
  return !(
    EXCLUDED_FILES.has(name) ||
    EXCLUDED_FILE_RES.some((pattern) => pattern.test(name))
  );
}

/**
 * The plan-state files of a work directory, in path order within the size
 * caps. Only regular files: a symlink is never followed into the bundle.
 */
export async function collectPlanStateFiles(
  workDir: string
): Promise<{ files: PlanStateFile[]; skipped: string[] }> {
  const files: PlanStateFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const relPath of await listFiles(workDir)) {
    if (relPath === PLAN_STATE_FILE || !isPlanStatePath(relPath)) {
      continue;
    }
    const absPath = path.join(workDir, ...relPath.split("/"));
    const stat = await fs.lstat(absPath);
    if (!stat.isFile()) {
      continue;
    }
    const size = stat.size;
    if (
      size > MAX_FILE_BYTES ||
      total + size > MAX_TOTAL_BYTES ||
      files.length >= MAX_FILES
    ) {
      skipped.push(relPath);
      continue;
    }
    files.push({ path: relPath, data: await fs.readFile(absPath) });
    total += size;
  }
  return { files, skipped };
}

/**
 * Summarizes where the plan stands after a loop: its phase and next step from
 * plan.json, and the loop appended to the history the work directory already
 * carried (restored from the previous loop of the plan).
 */
export async function buildPlanStateManifest(input: {
  workDir: string;
  loopId: string;
  command: string;
  outcome: PlanLoopOutcome;
  savedAt: string;
  skipped: string[];
}): Promise<PlanStateManifest> {
  const previous = await readPlanStateManifest(input.workDir);
  const plan = await readPlanSummary(path.join(input.workDir, "plan.json"));
  const { phase, nextStep } = planPosition(input.command, plan);
  const history = [
    ...(previous?.history ?? []).filter(
      (entry) => entry.loopId !== input.loopId
    ),
    {
      loopId: input.loopId,
      command: input.command,
      outcome: input.outcome,
      savedAt: input.savedAt,
      phase,
    },
  ].slice(-MAX_HISTORY);
  return {
    schemaVersion: 1,
    loopId: input.loopId,
    command: input.command,
    outcome: input.outcome,
    savedAt: input.savedAt,
    baseCommit: await readTrimmed(path.join(input.workDir, ".plan-base")),
    phase,
    nextStep,
    progress: {
      tasksTotal:
        (plan?.pendingTasks.length ?? 0) + (plan?.completedTasks.length ?? 0),
      tasksDone: plan?.completedTasks.length ?? 0,
      openQuestions: plan?.openQuestions.length ?? 0,
      answeredQuestions: plan?.answeredQuestions.length ?? 0,
    },
    history,
    skipped: input.skipped,
  };
}

/** The plan summary of a directory, or null when absent or unreadable. */
export async function readPlanStateManifest(
  dir: string
): Promise<PlanStateManifest | null> {
  const file = path.join(dir, PLAN_STATE_FILE);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = planStateManifestSchema.safeParse(
      JSON.parse(await fs.readFile(file, "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodePlanStateBundle(bundle: PlanStateBundle): Buffer {
  return gzipSync(
    JSON.stringify({
      schemaVersion: 1,
      manifest: bundle.manifest,
      files: bundle.files.map((file) => ({
        path: file.path,
        data: file.data.toString("base64"),
      })),
    })
  );
}

/** Parses a bundle; throws when it is not a valid plan-state bundle. */
export function decodePlanStateBundle(body: Buffer): PlanStateBundle {
  const json = gunzipSync(body, {
    maxOutputLength: MAX_BUNDLE_JSON_BYTES,
  }).toString("utf8");
  const parsed = bundleSchema.parse(JSON.parse(json));
  return {
    manifest: parsed.manifest,
    files: parsed.files.map((file) => ({
      path: file.path,
      data: Buffer.from(file.data, "base64"),
    })),
  };
}

/**
 * Whether a directory already holds the bundle's state: it was saved by the
 * bundle's loop, or by a later loop that started from it (whose own upload
 * may not have reached the API).
 */
export function isLocalPlanStateCurrent(
  local: PlanStateManifest | null,
  remote: PlanStateManifest
): boolean {
  return (
    local !== null &&
    (local.loopId === remote.loopId ||
      local.history.some((entry) => entry.loopId === remote.loopId))
  );
}

/**
 * Replaces the plan-state files of `targetDir` with the bundle's. Files that
 * are not plan state (logs, streams, learnings) stay as they are.
 */
export async function extractPlanStateBundle(
  bundle: PlanStateBundle,
  targetDir: string
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  for (const relPath of await listFiles(targetDir)) {
    if (isPlanStatePath(relPath)) {
      await fs.rm(path.join(targetDir, ...relPath.split("/")), {
        force: true,
      });
    }
  }
  const root = path.resolve(targetDir);
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    const absPath = path.join(root, ...segments);
    if (!absPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `Plan-state path escapes the work directory: ${file.path}`
      );
    }
    await ensureRealDir(root, segments.slice(0, -1));
    await fs.writeFile(absPath, file.data);
  }
}

function planPosition(
  command: string,
  plan: z.infer<typeof planSummarySchema> | null
): { phase: PlanPhase; nextStep: PlanNextStep } {
  if (!plan) {
    return { phase: PlanPhase.Started, nextStep: PlanNextStep.Plan };
  }
  if (plan.openQuestions.length > 0) {
    return {
      phase: PlanPhase.AwaitingAnswers,
      nextStep: PlanNextStep.AnswerQuestions,
    };
  }
  if (command !== LoopCommand.Execute) {
    return { phase: PlanPhase.Planned, nextStep: PlanNextStep.Execute };
  }
  if (plan.pendingTasks.length > 0) {
    return {
      phase: PlanPhase.Implementing,
      nextStep: PlanNextStep.ContinueExecution,
    };
  }
  return { phase: PlanPhase.Implemented, nextStep: PlanNextStep.Review };
}

async function readPlanSummary(
  file: string
): Promise<z.infer<typeof planSummarySchema> | null> {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = planSummarySchema.safeParse(
      JSON.parse(await fs.readFile(file, "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readTrimmed(file: string): Promise<string | null> {
  if (!existsSync(file)) {
    return null;
  }
  return (await fs.readFile(file, "utf8")).trim() || null;
}

/**
 * Files and symlinks under `dir` as sorted POSIX paths, without following
 * symlinked directories.
 */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      files.push(...(await listFiles(path.join(dir, entry.name), relPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relPath);
    }
  }
  return files.sort();
}

/** Creates `segments` under `root` as real directories, replacing symlinks. */
async function ensureRealDir(root: string, segments: string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isDirectory()) {
      continue;
    }
    if (stat) {
      await fs.rm(current, { force: true });
    }
    await fs.mkdir(current);
  }
}

function isSafeRelativePath(value: string): boolean {
  return (
    !(
      value.includes("\\") ||
      value.includes("\0") ||
      path.posix.isAbsolute(value)
    ) &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
