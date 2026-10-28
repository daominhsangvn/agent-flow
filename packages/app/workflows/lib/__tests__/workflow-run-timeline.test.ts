import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import {
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  type WorkflowRunError,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  type WorkflowRunLoopRef,
  type WorkflowRunPullRequest,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import { JIRA_TRANSITION_ISSUE } from "../../../integrations/__tests__/integration-fixtures";
import {
  buildRunTimeline,
  RunTimelineStepState,
} from "../workflow-run-timeline";

function loop(command: LoopCommand): WorkflowRunLoopRef {
  return {
    loopId: `loop-${command}`,
    command,
    status: LoopStatus.Completed,
    adopted: false,
    stepId: null,
    prUrl: null,
    startedAt: null,
    completedAt: null,
  };
}

function preActionRun(status: WorkflowActionRunStatus): WorkflowActionRun {
  return {
    id: "pre-1",
    actionId: "action-1",
    actionType: JIRA_TRANSITION_ISSUE,
    stage: WorkflowActionStage.Pre,
    event: WorkflowRunEvent.Triggered,
    cycle: 1,
    status,
    attempts: 1,
    lastError: null,
    externalRef: null,
    instruction: null,
    completedAt: null,
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
  };
}

type TimelineOptions = {
  loops?: WorkflowRunLoopRef[];
  pullRequests?: WorkflowRunPullRequest[];
  actionRuns?: WorkflowActionRun[];
  error?: WorkflowRunError | null;
};

function states(status: WorkflowRunStatus, options: TimelineOptions = {}) {
  return buildRunTimeline({
    status,
    loops: options.loops ?? [],
    pullRequests: options.pullRequests ?? [],
    actionRuns: options.actionRuns ?? [],
    error: options.error ?? null,
  }).map((step) => [step.label, step.state]);
}

const RAN_PRE_ACTIONS = {
  actionRuns: [preActionRun(WorkflowActionRunStatus.Succeeded)],
};

describe("buildRunTimeline", () => {
  it("marks earlier phases done and the current one in progress", () => {
    expect(states(WorkflowRunStatus.Planning, RAN_PRE_ACTIONS)).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Done],
      ["Planning", RunTimelineStepState.Current],
      ["Implementing", RunTimelineStepState.Upcoming],
      ["Done", RunTimelineStepState.Upcoming],
    ]);
  });

  it("runs the triggered actions after importing the item", () => {
    expect(
      states(WorkflowRunStatus.PreActions, {
        actionRuns: [preActionRun(WorkflowActionRunStatus.Pending)],
      })
    ).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Current],
      ["Planning", RunTimelineStepState.Upcoming],
      ["Implementing", RunTimelineStepState.Upcoming],
      ["Done", RunTimelineStepState.Upcoming],
    ]);
  });

  it("shows the triggered actions as upcoming for a run that was just received", () => {
    expect(states(WorkflowRunStatus.Received)[2]).toEqual([
      "Triggered actions",
      RunTimelineStepState.Upcoming,
    ]);
  });

  it("imports before the triggered actions run", () => {
    expect(states(WorkflowRunStatus.Ingesting).slice(0, 3)).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Current],
      ["Triggered actions", RunTimelineStepState.Upcoming],
    ]);
  });

  it("stays on the triggered actions while the run starts the agent team", () => {
    expect(
      states(WorkflowRunStatus.Ingesting, RAN_PRE_ACTIONS).slice(1, 4)
    ).toEqual([
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Current],
      ["Planning", RunTimelineStepState.Upcoming],
    ]);
  });

  it("skips the triggered actions of a workflow without them", () => {
    expect(states(WorkflowRunStatus.Planning).slice(1, 3)).toEqual([
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Skipped],
    ]);
  });

  it("shows needs input on the planning step", () => {
    expect(states(WorkflowRunStatus.NeedsInput)[3]).toEqual([
      "Needs input",
      RunTimelineStepState.Attention,
    ]);
  });

  it("shows a plan-only success as planned, never implemented", () => {
    expect(
      states(WorkflowRunStatus.Succeeded, {
        ...RAN_PRE_ACTIONS,
        loops: [loop(LoopCommand.Plan)],
      })
    ).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Done],
      ["Planning", RunTimelineStepState.Done],
      ["Implementing", RunTimelineStepState.Skipped],
      ["Succeeded", RunTimelineStepState.Succeeded],
    ]);
  });

  it("shows an implemented run through every phase", () => {
    const steps = states(WorkflowRunStatus.Succeeded, {
      ...RAN_PRE_ACTIONS,
      loops: [loop(LoopCommand.Plan), loop(LoopCommand.Execute)],
      pullRequests: [
        {
          url: "https://github.com/acme/web/pull/1",
          number: 1,
          repository: "acme/web",
          branch: "feat/proj-7",
        },
      ],
    });
    expect(
      steps
        .slice(0, 5)
        .every(([, state]) => state === RunTimelineStepState.Done)
    ).toBe(true);
  });

  it("shows a run that failed before planning as never planned", () => {
    expect(states(WorkflowRunStatus.Failed)).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Skipped],
      ["Planning", RunTimelineStepState.Skipped],
      ["Implementing", RunTimelineStepState.Skipped],
      ["Failed", RunTimelineStepState.Failed],
    ]);
  });

  it("stops a run whose triggered action failed before the agent team", () => {
    expect(
      states(WorkflowRunStatus.Failed, {
        actionRuns: [preActionRun(WorkflowActionRunStatus.Failed)],
        error: {
          code: WorkflowRunErrorCode.PreActionFailed,
          message: "Pre action Transition the issue failed: 403",
        },
      })
    ).toEqual([
      ["Received", RunTimelineStepState.Done],
      ["Importing", RunTimelineStepState.Done],
      ["Triggered actions", RunTimelineStepState.Failed],
      ["Planning", RunTimelineStepState.Skipped],
      ["Implementing", RunTimelineStepState.Skipped],
      ["Failed", RunTimelineStepState.Failed],
    ]);
  });

  it("ends a cancelled run on a cancelled step", () => {
    expect(states(WorkflowRunStatus.Cancelled).at(-1)).toEqual([
      "Cancelled",
      RunTimelineStepState.Cancelled,
    ]);
  });
});
