import type { JsonObject } from "@repo/api/src/types/common";
import {
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { runError } from "./errors";
import type { RunLoopState } from "./run-loops";

/**
 * What one step of the run state machine returns (phases.ts and the process
 * step modules): the run as a step sees it, and the transition advance.ts
 * applies under the lease together with the events it enqueues.
 */

export type EngineRun = {
  id: string;
  organizationId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  cycle: number;
  source: unknown;
  agentConfig: unknown;
  runAsUserId: string | null;
  connectionId: string | null;
  featureDocumentId: string | null;
  planDocumentId: string | null;
  phaseStartedAt: Date;
  /** Failed attempts of the current step (see step-retry.ts). */
  stepAttempts: number;
  /** Project process snapshot (process.ts); absent on the built-in flow. */
  process?: unknown;
  /** Current process step; absent on the built-in flow. */
  stepId?: string | null;
  /** Progress of the current process step (RunStepState). */
  stepState?: unknown;
  /** The trigger's project: the run's documents, process and connections. */
  projectId: string;
  /** The source project connection; null for the built-in HTTP endpoint. */
  projectConnectionId: string | null;
  workflow: { name: string; enabled: boolean };
};

/** Run columns a transition may set besides status/phaseStartedAt. */
export type RunTransitionData = {
  error?: WorkflowRunError | null;
  prUrl?: string | null;
  branchName?: string | null;
  /** New run cycle; the transition's events are enqueued for it. */
  cycle?: number;
  /** Process step the run moves to (runs with a process snapshot only). */
  stepId?: string;
  /** Process snapshot stored when the run starts on a project process. */
  process?: JsonObject;
  /** Progress of the current process step (RunStepState); null clears it. */
  stepState?: JsonObject | null;
};

/** What a step may use besides the run: the advance time and the run lease. */
export type StepContext = {
  now: Date;
  /** Extends the run lease (long inline work); false when it was lost. */
  renewLease(): Promise<boolean>;
};

export type StepOutcome =
  | { kind: "wait" }
  /** Temporary failure: keep the status, run the step again after delayMs. */
  | { kind: "retry"; delayMs: number; error: WorkflowRunError }
  | {
      kind: "transition";
      status: WorkflowRunStatus;
      events: WorkflowRunEvent[];
      data?: RunTransitionData;
    };

export const DEFAULT_PHASE_TIMEOUT_HOURS = 24;

export const WAIT: StepOutcome = { kind: "wait" };

export function transition(
  status: WorkflowRunStatus,
  events: WorkflowRunEvent[] = [],
  data?: RunTransitionData
): StepOutcome {
  return { kind: "transition", status, events, data };
}

export function failRun(
  error: WorkflowRunError,
  events: WorkflowRunEvent[] = []
): StepOutcome {
  return transition(
    WorkflowRunStatus.Failed,
    [...events, WorkflowRunEvent.Failed],
    { error }
  );
}

/** Hours a run may stay in one loop phase (WORKFLOW_RUN_PHASE_TIMEOUT_HOURS). */
export function phaseTimeoutHours(): number {
  const raw = process.env.WORKFLOW_RUN_PHASE_TIMEOUT_HOURS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PHASE_TIMEOUT_HOURS;
}

export function phaseTimedOut(run: EngineRun, now: Date): boolean {
  const limitMs = phaseTimeoutHours() * 60 * 60 * 1000;
  return now.getTime() - run.phaseStartedAt.getTime() > limitMs;
}

export function timeoutFailure(phase: string): StepOutcome {
  return failRun(
    runError(
      WorkflowRunErrorCode.PhaseTimeout,
      `The run spent more than ${phaseTimeoutHours()} hours ${phase}.`
    )
  );
}

export function loopFailure(
  code: WorkflowRunErrorCode,
  command: string,
  loop: RunLoopState
): WorkflowRunError {
  const detail = loop.error?.message ? `: ${loop.error.message}` : ".";
  return runError(
    code,
    `The ${command} loop ended with status ${loop.status}${detail}`
  );
}
