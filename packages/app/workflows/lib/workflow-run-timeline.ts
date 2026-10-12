import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import {
  WorkflowActionStage,
  type WorkflowRunDetail,
  WorkflowRunErrorCode,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WORKFLOW_RUN_STATUS_LABELS } from "./workflow-labels";

/**
 * The phase stepper of the run detail page, derived from the run status, its
 * loops and its action runs. A final run shows which phases it actually went
 * through (a plan mode run never implements; a run whose pre action failed
 * never imported; a workflow without pre actions skips that phase), instead
 * of pretending every phase completed.
 */

export const RunTimelineStepState = {
  Done: "done",
  Current: "current",
  Attention: "attention",
  Upcoming: "upcoming",
  Skipped: "skipped",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type RunTimelineStepState =
  (typeof RunTimelineStepState)[keyof typeof RunTimelineStepState];

export type RunTimelineStep = {
  key: string;
  label: string;
  state: RunTimelineStepState;
};

/** The parts of a run the timeline reads. */
export type RunTimelineInput = Pick<
  WorkflowRunDetail,
  "status" | "loops" | "prUrl" | "actionRuns" | "error"
>;

export function buildRunTimeline(run: RunTimelineInput): RunTimelineStep[] {
  const finalStep = FINAL_STEPS.get(run.status);
  if (finalStep) {
    return buildFinalTimeline(run, finalStep);
  }
  return buildActiveTimeline(run);
}

function buildActiveTimeline(run: RunTimelineInput): RunTimelineStep[] {
  // Needs input happens after the plan was written, so it is shown on the
  // planning step rather than as a phase of its own; a process approval
  // waits on the implementation phase.
  const isWaiting =
    run.status === WorkflowRunStatus.NeedsInput ||
    run.status === WorkflowRunStatus.NeedsApproval;
  const currentPhase =
    run.status === WorkflowRunStatus.NeedsInput
      ? WorkflowRunStatus.Planning
      : timelinePhase(run.status);
  const currentIndex = PHASES.indexOf(currentPhase);
  const ranPreActions = hasPreActionRuns(run);

  const steps = PHASES.map((phase, index): RunTimelineStep => {
    if (index < currentIndex) {
      return phaseStep(phase, passedPhaseState(phase, ranPreActions));
    }
    if (index > currentIndex) {
      return phaseStep(phase, RunTimelineStepState.Upcoming);
    }
    if (isWaiting) {
      return {
        key: phase,
        label: WORKFLOW_RUN_STATUS_LABELS[run.status],
        state: RunTimelineStepState.Attention,
      };
    }
    return phaseStep(phase, RunTimelineStepState.Current);
  });
  steps.push({
    key: FINAL_STEP_KEY,
    label: "Done",
    state: RunTimelineStepState.Upcoming,
  });
  return steps;
}

function buildFinalTimeline(
  run: RunTimelineInput,
  finalStep: FinalStep
): RunTimelineStep[] {
  const planned = run.loops.some((loop) => loop.command === LoopCommand.Plan);
  const executed =
    Boolean(run.prUrl) ||
    run.loops.some((loop) => AGENT_WORK_COMMANDS.has(loop.command));
  const stoppedByPreAction =
    run.error?.code === WorkflowRunErrorCode.PreActionFailed;

  const reached = new Map<WorkflowRunStatus, boolean>([
    [WorkflowRunStatus.Received, true],
    [WorkflowRunStatus.PreActions, hasPreActionRuns(run)],
    [WorkflowRunStatus.Ingesting, !stoppedByPreAction],
    [WorkflowRunStatus.Planning, planned || executed],
    [WorkflowRunStatus.Executing, executed],
  ]);

  const steps = PHASES.map((phase) => {
    if (stoppedByPreAction && phase === WorkflowRunStatus.PreActions) {
      return phaseStep(phase, RunTimelineStepState.Failed);
    }
    return phaseStep(
      phase,
      reached.get(phase)
        ? RunTimelineStepState.Done
        : RunTimelineStepState.Skipped
    );
  });
  steps.push({ key: FINAL_STEP_KEY, ...finalStep });
  return steps;
}

/**
 * The agent steps of a project process (`running`) are shown on the
 * implementation phase until the timeline follows the process's own steps.
 */
function timelinePhase(status: WorkflowRunStatus): WorkflowRunStatus {
  return status === WorkflowRunStatus.Running ||
    status === WorkflowRunStatus.NeedsApproval
    ? WorkflowRunStatus.Executing
    : status;
}

/** Loops that work on the implementation (EXECUTE, process agent steps). */
const AGENT_WORK_COMMANDS: ReadonlySet<string> = new Set<string>([
  LoopCommand.Execute,
  LoopCommand.Step,
]);

/** A phase the run already left: done, or skipped for a workflow without pre actions. */
function passedPhaseState(
  phase: WorkflowRunStatus,
  ranPreActions: boolean
): RunTimelineStepState {
  if (phase === WorkflowRunStatus.PreActions && !ranPreActions) {
    return RunTimelineStepState.Skipped;
  }
  return RunTimelineStepState.Done;
}

function hasPreActionRuns(run: Pick<RunTimelineInput, "actionRuns">): boolean {
  return run.actionRuns.some(
    (actionRun) => actionRun.stage === WorkflowActionStage.Pre
  );
}

function phaseStep(
  phase: WorkflowRunStatus,
  state: RunTimelineStepState
): RunTimelineStep {
  return {
    key: phase,
    label: PHASE_LABELS.get(phase) ?? WORKFLOW_RUN_STATUS_LABELS[phase],
    state,
  };
}

type FinalStep = { label: string; state: RunTimelineStepState };

const PHASES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.Received,
  WorkflowRunStatus.PreActions,
  WorkflowRunStatus.Ingesting,
  WorkflowRunStatus.Planning,
  WorkflowRunStatus.Executing,
];

/** Step labels that differ from the status badge ("Running pre actions"). */
const PHASE_LABELS = new Map<WorkflowRunStatus, string>([
  [WorkflowRunStatus.PreActions, "Pre actions"],
]);

const FINAL_STEP_KEY = "final";

const FINAL_STEPS = new Map<WorkflowRunStatus, FinalStep>([
  [
    WorkflowRunStatus.Succeeded,
    {
      label: WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.Succeeded],
      state: RunTimelineStepState.Succeeded,
    },
  ],
  [
    WorkflowRunStatus.Failed,
    {
      label: WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.Failed],
      state: RunTimelineStepState.Failed,
    },
  ],
  [
    WorkflowRunStatus.Cancelled,
    {
      label: WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.Cancelled],
      state: RunTimelineStepState.Cancelled,
    },
  ],
]);
