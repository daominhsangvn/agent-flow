import {
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunErrorCode,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { describe, expect, it } from "vitest";
import {
  describeWorkflowRunError,
  WORKFLOW_RUN_ERROR_MESSAGES,
} from "../workflow-error-messages";
import {
  WORKFLOW_ACTION_RUN_STATUS_LABELS,
  WORKFLOW_ACTION_RUN_STATUS_TONES,
  WORKFLOW_ACTION_STAGE_LABELS,
  WORKFLOW_AGENT_MODE_DESCRIPTIONS,
  WORKFLOW_AGENT_MODE_LABELS,
  WORKFLOW_RUN_EVENT_DESCRIPTIONS,
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_RUN_EVENT_ORDER,
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_RUN_STATUS_TONES,
} from "../workflow-labels";

type CoverageCase = [
  name: string,
  values: Record<string, string>,
  map: Record<string, string>,
];

/** Every value of a const object needs a non-empty entry in its map, and nothing else. */
const COVERAGE_CASES: CoverageCase[] = [
  ["run status labels", WorkflowRunStatus, WORKFLOW_RUN_STATUS_LABELS],
  ["run status tones", WorkflowRunStatus, WORKFLOW_RUN_STATUS_TONES],
  ["run event labels", WorkflowRunEvent, WORKFLOW_RUN_EVENT_LABELS],
  ["run event descriptions", WorkflowRunEvent, WORKFLOW_RUN_EVENT_DESCRIPTIONS],
  ["action stage labels", WorkflowActionStage, WORKFLOW_ACTION_STAGE_LABELS],
  [
    "action run status labels",
    WorkflowActionRunStatus,
    WORKFLOW_ACTION_RUN_STATUS_LABELS,
  ],
  [
    "action run status tones",
    WorkflowActionRunStatus,
    WORKFLOW_ACTION_RUN_STATUS_TONES,
  ],
  ["agent mode labels", WorkflowAgentMode, WORKFLOW_AGENT_MODE_LABELS],
  [
    "agent mode descriptions",
    WorkflowAgentMode,
    WORKFLOW_AGENT_MODE_DESCRIPTIONS,
  ],
  ["run error messages", WorkflowRunErrorCode, WORKFLOW_RUN_ERROR_MESSAGES],
];

describe("workflow labels", () => {
  it.each(COVERAGE_CASES)("%s cover every value", (_name, values, map) => {
    const expected = Object.values(values);
    expect(Object.keys(map).sort()).toEqual([...expected].sort());
    expect(expected.filter((value) => !map[value]?.trim())).toEqual([]);
  });

  it("names the pre action status and event", () => {
    expect(WORKFLOW_RUN_STATUS_LABELS[WorkflowRunStatus.PreActions]).toBe(
      "Running pre actions"
    );
    expect(WORKFLOW_RUN_EVENT_LABELS[WorkflowRunEvent.Triggered]).toBe(
      "Trigger received (pre actions)"
    );
  });

  it("orders every event by lifecycle, the post action events after the trigger", () => {
    expect([...WORKFLOW_RUN_EVENT_ORDER].sort()).toEqual(
      Object.values(WorkflowRunEvent).sort()
    );
    expect(WORKFLOW_RUN_EVENT_ORDER).toEqual([
      WorkflowRunEvent.Triggered,
      ...WORKFLOW_POST_ACTION_EVENTS,
    ]);
  });
});

describe("workflow run error messages", () => {
  it("pairs the readable title with the engine's message", () => {
    expect(
      describeWorkflowRunError({
        code: WorkflowRunErrorCode.PreActionFailed,
        message: "Pre action Transition the issue failed: Jira returned 403",
      })
    ).toEqual({
      title: WORKFLOW_RUN_ERROR_MESSAGES[WorkflowRunErrorCode.PreActionFailed],
      detail: "Pre action Transition the issue failed: Jira returned 403",
    });
  });

  it("falls back to the raw code for a code this UI does not know", () => {
    expect(
      describeWorkflowRunError({ code: "brand_new_code", message: "Boom" })
    ).toEqual({ title: "brand_new_code", detail: "Boom" });
  });
});
