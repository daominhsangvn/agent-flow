import {
  ExecutionResultV2Schema,
  type RepoExecutionResult,
} from "@agentflow-ai/loops-api/execution-result";
import {
  LoopCommand,
  LoopEventType,
  LoopStatus,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { z } from "zod";
import {
  REVIVAL_GRACE_WINDOW_MS,
  REVIVAL_MAX_PER_LOOP,
} from "@/app/loops/loop-constants";
import { extractUploadedPlanRaw } from "@/lib/loops/uploaded-plan-artifacts";
import { ReapReason } from "@/lib/observability/loop-runner-metrics";

/**
 * Loops that belong to a workflow run. `workflow_run_loops` is the source of
 * truth for the mapping (Loop.metadata is replaced by several terminal
 * writers); the Loop row is read for the live status, PR fields and uploaded
 * plan artifacts.
 */

/** Commands the engine launches or adopts. */
export type EngineLoopCommand =
  | typeof LoopCommand.Plan
  | typeof LoopCommand.Execute
  | typeof LoopCommand.Step;

export type RunLoopState = {
  loopId: string;
  command: string;
  adopted: boolean;
  /** The process step a STEP loop ran. */
  stepId: string | null;
  linkedAt: Date;
  status: LoopStatus;
  computeTargetId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  error: { code: string; message: string } | null;
  uploadedArtifacts: unknown;
  /** Times the loop went from TIMED_OUT back to RUNNING. */
  revivalCount: number;
  /** The agent session the computer recorded; a later loop can resume it. */
  sessionId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

/** What deciding whether a loop ended for good reads. */
export type SettlingLoop = Pick<
  RunLoopState,
  "loopId" | "status" | "completedAt" | "revivalCount"
>;

const LOOP_TERMINAL_STATUSES: ReadonlySet<LoopStatus> = new Set<LoopStatus>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

const ADOPTABLE_COMMANDS: EngineLoopCommand[] = [
  LoopCommand.Plan,
  LoopCommand.Execute,
];

const RUN_LOOP_SELECT = {
  loopId: true,
  command: true,
  adopted: true,
  stepId: true,
  createdAt: true,
  loop: {
    select: {
      status: true,
      computeTargetId: true,
      prUrl: true,
      prNumber: true,
      branchName: true,
      error: true,
      uploadedArtifacts: true,
      revivalCount: true,
      sessionId: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  },
} as const;

const loopErrorSchema = z.object({
  code: z.string().default("unknown"),
  message: z.string(),
});

/** Reaper data of a TIMED_OUT error event (cron/timeout-loops/reaper-helpers.ts). */
const reaperEventDataSchema = z.object({
  reaper: z.object({ reason: z.string().optional() }).optional(),
});

/** Reap reasons reviveTimedOutLoop accepts. */
const HEARTBEAT_STALENESS_REAP_REASONS: ReadonlySet<string> = new Set<string>([
  ReapReason.DesktopHeartbeatStale,
  ReapReason.DesktopNoHeartbeat,
]);

const planOpenQuestionsSchema = z.object({
  openQuestions: z
    .array(z.object({ question: z.string() }).passthrough())
    .default([]),
});

export function isLoopTerminal(status: LoopStatus): boolean {
  return LOOP_TERMINAL_STATUSES.has(status);
}

/**
 * True when the loop has ended for good. A TIMED_OUT desktop loop that the
 * loop service can still revive on its next heartbeat (see
 * isRevivableTimedOutLoop) has not: a sleeping laptop wakes up and finishes
 * the loop, so the run keeps waiting (bounded by the phase timeout).
 */
export async function isLoopSettled(
  loop: SettlingLoop,
  now: Date
): Promise<boolean> {
  if (!isLoopTerminal(loop.status)) {
    return false;
  }
  if (loop.status !== LoopStatus.TimedOut) {
    return true;
  }
  return !(await isRevivableTimedOutLoop(loop, now));
}

/**
 * Mirrors the guards of reviveTimedOutLoop (app/loops/service.ts): the
 * latest error event was written by the reaper for heartbeat staleness, the
 * loop timed out less than REVIVAL_GRACE_WINDOW_MS ago, and it has been
 * revived fewer than REVIVAL_MAX_PER_LOOP times.
 */
export async function isRevivableTimedOutLoop(
  loop: SettlingLoop,
  now: Date
): Promise<boolean> {
  if (loop.status !== LoopStatus.TimedOut || !loop.completedAt) {
    return false;
  }
  if (now.getTime() - loop.completedAt.getTime() > REVIVAL_GRACE_WINDOW_MS) {
    return false;
  }
  if (loop.revivalCount >= REVIVAL_MAX_PER_LOOP) {
    return false;
  }
  const event = await withDb((db) =>
    db.loopEvent.findFirst({
      where: { loopId: loop.loopId, type: LoopEventType.Error },
      orderBy: { createdAt: "desc" },
      select: { data: true },
    })
  );
  const parsed = reaperEventDataSchema.safeParse(event?.data);
  const reason = parsed.success ? parsed.data.reaper?.reason : undefined;
  return reason !== undefined && HEARTBEAT_STALENESS_REAP_REASONS.has(reason);
}

/**
 * Latest loop of the run for one command (engine-launched or adopted), of
 * one process step when `stepId` is given (STEP loops).
 */
export async function findLatestRunLoop(
  runId: string,
  command: EngineLoopCommand,
  since?: Date,
  stepId?: string
): Promise<RunLoopState | null> {
  const row = await withDb((db) =>
    db.workflowRunLoop.findFirst({
      where: {
        runId,
        command,
        ...(since ? { createdAt: { gte: since } } : {}),
        ...(stepId ? { stepId } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: RUN_LOOP_SELECT,
    })
  );
  return row ? toRunLoopState(row) : null;
}

/** Every loop of the run, oldest first. */
export async function listRunLoops(runId: string): Promise<RunLoopState[]> {
  const rows = await withDb((db) =>
    db.workflowRunLoop.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      select: RUN_LOOP_SELECT,
    })
  );
  return rows.map(toRunLoopState);
}

/**
 * A PLAN or EXECUTE loop someone started on the run's plan document after the
 * run entered needs_input, not yet mapped to any run (newest first).
 */
export async function findAdoptableLoop(input: {
  organizationId: string;
  planDocumentId: string;
  since: Date;
}): Promise<{ id: string; command: EngineLoopCommand } | null> {
  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        organizationId: input.organizationId,
        artifactId: input.planDocumentId,
        command: { in: ADOPTABLE_COMMANDS },
        createdAt: { gt: input.since },
        workflowRunLoop: { is: null },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, command: true },
    })
  );
  if (!loop) {
    return null;
  }
  const command =
    loop.command === LoopCommand.Execute
      ? LoopCommand.Execute
      : LoopCommand.Plan;
  return { id: loop.id, command };
}

/**
 * Links a loop to a run. Idempotent: a loop belongs to at most one run. A
 * STEP loop also records the process step it runs.
 */
export async function recordRunLoop(input: {
  organizationId: string;
  runId: string;
  loopId: string;
  command: EngineLoopCommand;
  adopted: boolean;
  stepId?: string;
}): Promise<void> {
  await withDb((db) =>
    db.workflowRunLoop.createMany({
      data: [input],
      skipDuplicates: true,
    })
  );
}

/**
 * Whether a PLAN loop re-plans its workflow run: the run already completed a
 * PLAN loop (it stopped on open questions and the answers came back), so the
 * computer revises that plan with the answers instead of planning from
 * scratch. A PLAN loop outside a workflow run (the Plan action on a document)
 * is never a re-plan.
 */
export async function isRunReplanLoop(
  loop: { id: string; command: string },
  organizationId: string
): Promise<boolean> {
  if (loop.command !== LoopCommand.Plan) {
    return false;
  }
  const link = await withDb((db) =>
    db.workflowRunLoop.findFirst({
      where: { loopId: loop.id, organizationId },
      select: { runId: true },
    })
  );
  if (!link) {
    return false;
  }
  const earlier = await withDb((db) =>
    db.workflowRunLoop.count({
      where: {
        organizationId,
        runId: link.runId,
        command: LoopCommand.Plan,
        loopId: { not: loop.id },
        loop: { status: LoopStatus.Completed },
      },
    })
  );
  return earlier > 0;
}

/** Open questions of a completed PLAN loop (from the uploaded plan.json). */
export function readOpenQuestions(uploadedArtifacts: unknown): string[] {
  const raw = extractUploadedPlanRaw(uploadedArtifacts);
  if (!raw) {
    return [];
  }
  const parsed = planOpenQuestionsSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.openQuestions
    .map((entry) => entry.question.trim())
    .filter((question) => question !== "");
}

/**
 * Per-repository results of a completed EXECUTE loop (the uploaded V2
 * execution result): which repositories were pushed, to which branch.
 */
export function readRepoExecutionResults(
  uploadedArtifacts: unknown
): RepoExecutionResult[] {
  const parsed = uploadedExecutionResultSchema.safeParse(uploadedArtifacts);
  return parsed.success ? parsed.data.executionResult.results : [];
}

const uploadedExecutionResultSchema = z.object({
  executionResult: ExecutionResultV2Schema,
});

function toRunLoopState(row: {
  loopId: string;
  command: string;
  adopted: boolean;
  stepId: string | null;
  createdAt: Date;
  loop: {
    status: LoopStatus;
    computeTargetId: string | null;
    prUrl: string | null;
    prNumber: number | null;
    branchName: string | null;
    error: unknown;
    uploadedArtifacts: unknown;
    revivalCount: number;
    sessionId?: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  };
}): RunLoopState {
  const error = loopErrorSchema.safeParse(row.loop.error);
  return {
    loopId: row.loopId,
    command: row.command,
    adopted: row.adopted,
    stepId: row.stepId,
    linkedAt: row.createdAt,
    status: row.loop.status,
    computeTargetId: row.loop.computeTargetId,
    prUrl: row.loop.prUrl,
    prNumber: row.loop.prNumber,
    branchName: row.loop.branchName,
    error: error.success ? error.data : null,
    uploadedArtifacts: row.loop.uploadedArtifacts,
    revivalCount: row.loop.revivalCount,
    sessionId: row.loop.sessionId ?? null,
    createdAt: row.loop.createdAt,
    startedAt: row.loop.startedAt,
    completedAt: row.loop.completedAt,
  };
}
