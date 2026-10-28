import {
  LoopStepConfigSchema,
  LoopStepToolkitSchema,
} from "@agentflow-ai/loops-api/loop-step";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * What a runner can do, declared by its owner in `AGENTFLOW.md`
 * (docs/runner.md "Capabilities (AGENTFLOW.md)"): the Claude Code commands and
 * skills the runner has, with what each one is for, so a project's
 * orchestrator knows which command of which runner to send a request to.
 *
 * The file is Markdown with a YAML front matter. The front matter is the part
 * AgentFlow reads (and later checks); the body is the detailed description the
 * orchestrator reads as it is.
 *
 *   ---
 *   runner: Dev (LeaveDesk)
 *   commands:
 *     - name: /plan-ticket
 *       args: <ticket-key>
 *       mode: write
 *       produces: plan
 *       needs: [prd]
 *       asks: true
 *       attach: ["PLAN-*.md"]
 *   skills: [tdd]
 *   ---
 *   # Dev runner
 *   ## /plan-ticket
 *   Reads the PRD attached to the ticket and writes the plan to ...
 *
 * A personal runner reads the file from its project folder; an auto runner
 * from the root of the project's toolkit repository.
 */

export const RUNNER_CAPABILITIES_FILE_NAME = "AGENTFLOW.md";

/** Largest `AGENTFLOW.md` a runner uploads (and the API accepts). */
export const RUNNER_CAPABILITIES_MAX_CHARS = 100_000;

export const RUNNER_CAPABILITIES_MAX_COMMANDS = 100;
export const RUNNER_CAPABILITIES_MAX_SKILLS = 100;
export const RUNNER_CAPABILITIES_MAX_WARNINGS = 50;
export const RUNNER_COMMAND_ATTACH_MAX = 10;

/** Whether a command only reads or may change files, systems or the plan. */
export const RunnerCommandMode = {
  Read: "read",
  Write: "write",
} as const;
export type RunnerCommandMode =
  (typeof RunnerCommandMode)[keyof typeof RunnerCommandMode];

/** Where a runner's `AGENTFLOW.md` was read from. */
export const RunnerCapabilitiesSource = {
  /** The project folder of a personal runner. */
  Personal: "personal",
  /** The root of the project's toolkit repository (auto runner). */
  Toolkit: "toolkit",
} as const;
export type RunnerCapabilitiesSource =
  (typeof RunnerCapabilitiesSource)[keyof typeof RunnerCapabilitiesSource];

const COMMAND_NAME_RE = /^\/[\w:.-]{1,100}$/;
const SKILL_NAME_RE = /^[\w:.-]{1,100}$/;
const TAG_RE = /^[a-z][a-z0-9-]{0,39}$/;
const FRONT_MATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const tagSchema = z
  .string()
  .trim()
  .regex(TAG_RE, "a lowercase word such as plan, prd or approved-plan");

export const runnerCommandSchema = z.object({
  /** The slash command as typed in Claude Code, e.g. `/plan-ticket`. */
  name: z
    .string()
    .trim()
    .regex(COMMAND_NAME_RE, "a slash command such as /plan-ticket"),
  /** How its arguments are written, e.g. `<ticket-key>`. */
  args: z.string().trim().max(200).optional(),
  /** One line on what it is for; the body of the file says more. */
  description: z.string().trim().max(500).optional(),
  mode: z.enum(RunnerCommandMode),
  /** What it produces: prd, plan, testcases, code, answer, ... */
  produces: tagSchema.optional(),
  /** What must exist before it runs, e.g. prd or approved-plan. */
  needs: z.array(tagSchema).max(10).optional(),
  /** It may stop with questions (written to questions.json). */
  asks: z.boolean().optional(),
  /** It commits and pushes. */
  push: z.boolean().optional(),
  /**
   * Files it writes for the ticket: globs relative to the task's work
   * directory (`.agentflow-ai/work/` of an auto runner's workspace,
   * `$AGENTFLOW_WORKDIR` on a personal runner), e.g. PRD-*.md. An
   * orchestrator task collects them when it ends; the orchestrator can attach
   * them to the ticket.
   */
  attach: z
    .array(LoopStepConfigSchema.shape.artifacts.element)
    .max(RUNNER_COMMAND_ATTACH_MAX)
    .optional(),
});
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;

export const runnerSkillSchema = z.union([
  z.string().trim().regex(SKILL_NAME_RE, "a skill name such as tdd"),
  z.object({
    name: z.string().trim().regex(SKILL_NAME_RE, "a skill name such as tdd"),
    description: z.string().trim().max(500).optional(),
  }),
]);

/**
 * Where an auto runner's commands and skills live: a project repository whose
 * directories are linked into the task's workspace (like a process toolkit).
 * A personal runner has its own in its folder and ignores it.
 */
export const runnerToolkitSchema = z.object({
  /** The project repository (owner/name), e.g. workshop/leavedesk-knowledge. */
  repository: LoopStepToolkitSchema.shape.repository,
  /** Its directories linked into the workspace root, e.g. .claude/skills. */
  mounts: LoopStepToolkitSchema.shape.mounts,
  /** Added to the workspace CLAUDE.md of the runner's tasks. */
  instructions: LoopStepToolkitSchema.shape.instructions.optional(),
});
export type RunnerToolkit = z.infer<typeof runnerToolkitSchema>;

export const runnerCapabilitiesFrontMatterSchema = z.object({
  /** A display name for the runner's role, e.g. "Dev (LeaveDesk)". */
  runner: z.string().trim().max(120).optional(),
  toolkit: runnerToolkitSchema.optional(),
  commands: z
    .array(runnerCommandSchema)
    .max(RUNNER_CAPABILITIES_MAX_COMMANDS)
    .default([]),
  skills: z
    .array(runnerSkillSchema)
    .max(RUNNER_CAPABILITIES_MAX_SKILLS)
    .default([]),
});

export const runnerCapabilitiesSchema = z.object({
  runner: z.string().nullable(),
  // Files stored before toolkits read as having none.
  toolkit: runnerToolkitSchema.nullable().default(null),
  commands: z.array(runnerCommandSchema),
  skills: z.array(
    z.object({ name: z.string(), description: z.string().optional() })
  ),
});

/** The front matter of an `AGENTFLOW.md`, normalized (as stored). */
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;
export type RunnerSkill = RunnerCapabilities["skills"][number];

export type RunnerCapabilitiesParseResult =
  | { ok: true; value: RunnerCapabilities; body: string }
  | { ok: false; problems: string[] };

/** What a runner uploads: the file as it is, and what it found checking it. */
export const uploadRunnerCapabilitiesInputSchema = z.object({
  /** The AgentFlow project the file is for (its key, e.g. PRO-1, or id). */
  project: z.string().trim().min(1).max(120),
  source: z.enum(RunnerCapabilitiesSource),
  content: z.string().max(RUNNER_CAPABILITIES_MAX_CHARS),
  /** Problems only the runner can see, e.g. a declared command it does not have. */
  warnings: z
    .array(z.string().trim().min(1).max(500))
    .max(RUNNER_CAPABILITIES_MAX_WARNINGS)
    .default([]),
});
export type UploadRunnerCapabilitiesInput = z.infer<
  typeof uploadRunnerCapabilitiesInputSchema
>;

/** A runner's stored `AGENTFLOW.md` for one project. */
export type ComputeTargetCapabilities = {
  id: string;
  computeTargetId: string;
  /** The runner's name, as it registered. */
  runnerName: string;
  isOnline: boolean;
  projectId: string;
  source: RunnerCapabilitiesSource;
  content: string;
  /** null when the front matter does not parse; `problems` say why. */
  capabilities: RunnerCapabilities | null;
  problems: string[];
  warnings: string[];
  contentHash: string;
  uploadedAt: string;
};

/**
 * Reads the front matter of an `AGENTFLOW.md`. Pure, so the runner (to warn
 * its owner before uploading) and the API (which stores what it parsed itself)
 * read the file the same way.
 */
export function parseRunnerCapabilitiesMarkdown(
  content: string
): RunnerCapabilitiesParseResult {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) {
    return {
      ok: false,
      problems: [
        "The file has no front matter: start it with a --- block that lists the commands.",
      ],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch (error) {
    return {
      ok: false,
      problems: [
        `The front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const parsed = runnerCapabilitiesFrontMatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "front matter"}: ${issue.message}`
      ),
    };
  }
  const duplicates = duplicateNames(parsed.data.commands.map((c) => c.name));
  if (duplicates.length > 0) {
    return {
      ok: false,
      problems: duplicates.map((name) => `commands: ${name} is listed twice`),
    };
  }
  return {
    ok: true,
    value: {
      runner: parsed.data.runner ?? null,
      toolkit: parsed.data.toolkit ?? null,
      commands: parsed.data.commands,
      skills: parsed.data.skills.map((skill) =>
        typeof skill === "string" ? { name: skill } : skill
      ),
    },
    body: content.slice(match[0].length).trim(),
  };
}

function duplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return [...duplicates];
}

export const RUNNER_CAPABILITIES_REFRESH_OPERATION_ID = "capabilities_refresh";
export const RUNNER_CAPABILITIES_REFRESH_GATEWAY_PATH =
  "/api/gateway/capabilities/refresh";
export const RUNNER_CAPABILITIES_REFRESH_TIMEOUT_MS = 5 * 60_000;
export const RUNNER_CAPABILITIES_REFRESH_ERROR_MAX = 2000;

/** The command body the API sends a runner to read its toolkit's AGENTFLOW.md. */
export const runnerCapabilitiesRefreshRequestSchema = z.object({
  refreshId: z.uuid(),
  projectId: z.uuid(),
  repository: LoopStepToolkitSchema.shape.repository,
  cloneUrl: z.string().min(1).max(2000),
  defaultBranch: z.string().trim().min(1).max(255),
});
export type RunnerCapabilitiesRefreshRequest = z.infer<
  typeof runnerCapabilitiesRefreshRequestSchema
>;

/** The runner's answer to a refresh command (the command's `result` event). */
export const runnerCapabilitiesRefreshResultSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({
      type: z.literal("result"),
      ok: z.literal(true),
      contentHash: z.string().max(64),
      warningCount: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("result"),
      ok: z.literal(false),
      error: z.string().max(RUNNER_CAPABILITIES_REFRESH_ERROR_MAX),
    }),
  ]
);
export type RunnerCapabilitiesRefreshResult = z.infer<
  typeof runnerCapabilitiesRefreshResultSchema
>;

/** What an admin sends to have a runner read its toolkit. */
export const requestRunnerCapabilitiesRefreshInputSchema = z.object({
  project: z.string().trim().min(1).max(120),
  repository: LoopStepToolkitSchema.shape.repository.optional(),
});
export type RequestRunnerCapabilitiesRefreshInput = z.infer<
  typeof requestRunnerCapabilitiesRefreshInputSchema
>;

export const RunnerCapabilitiesRefreshStatus = {
  Pending: "pending",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type RunnerCapabilitiesRefreshStatus =
  (typeof RunnerCapabilitiesRefreshStatus)[keyof typeof RunnerCapabilitiesRefreshStatus];

export type RunnerCapabilitiesRefresh = {
  refreshId: string;
  computeTargetId: string;
  projectId: string;
  repository: string;
  status: RunnerCapabilitiesRefreshStatus;
  error: string | null;
};

/** The API path a runner posts git's credential description to during a refresh. */
export function runnerCapabilitiesGitCredentialPath(
  computeTargetId: string,
  refreshId: string
): string {
  return `/compute-targets/${encodeURIComponent(computeTargetId)}/capabilities/refresh/${encodeURIComponent(refreshId)}/git-credential`;
}

/** The refresh command's idempotency key. */
export function runnerCapabilitiesRefreshKey(refreshId: string): string {
  return `capabilities_refresh:${refreshId}`;
}
