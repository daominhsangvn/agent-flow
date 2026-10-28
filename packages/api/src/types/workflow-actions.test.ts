import { describe, expect, it } from "vitest";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionStage,
  WorkflowInstructionOperationStatus,
  WorkflowRunEvent,
  workflowActionInputSchema,
  workflowInstructionRunDetailSchema,
  workflowRunEventSchema,
} from "./workflow";

const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";

describe("workflowRunEventSchema", () => {
  it("accepts the event names after AgentFlow's phases", () => {
    expect(workflowRunEventSchema.parse("execute.completed")).toBe(
      WorkflowRunEvent.ExecuteCompleted
    );
    expect(workflowRunEventSchema.parse("plan.completed")).toBe(
      WorkflowRunEvent.PlanReady
    );
  });

  it.each([
    ["run.triggered", WorkflowRunEvent.Triggered],
    ["run.started", WorkflowRunEvent.Started],
    ["run.plan_ready", WorkflowRunEvent.PlanReady],
    ["run.needs_input", WorkflowRunEvent.NeedsInput],
    ["run.succeeded", WorkflowRunEvent.Succeeded],
    ["run.failed", WorkflowRunEvent.Failed],
  ])("still accepts the old name %s as %s", (legacy, current) => {
    expect(workflowRunEventSchema.parse(legacy)).toBe(current);
  });

  it("refuses an unknown event", () => {
    expect(workflowRunEventSchema.safeParse("run.exploded").success).toBe(
      false
    );
  });
});

describe("workflowActionInputSchema", () => {
  it("maps old event names of a saved action", () => {
    const action = workflowActionInputSchema.parse({
      connectionId: CONNECTION_ID,
      type: "jira.add_comment",
      events: ["run.plan_ready", "run.succeeded"],
    });

    expect(action.events).toEqual([
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.Succeeded,
    ]);
  });

  it("accepts an instruction whose connection is chosen when it runs", () => {
    const action = workflowActionInputSchema.parse({
      connectionId: null,
      automaticConnection: true,
      type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
      config: { instruction: "Move the issue to In Progress." },
      stage: WorkflowActionStage.Pre,
    });

    expect(action).toMatchObject({
      connectionId: null,
      automaticConnection: true,
    });
  });

  it("refuses an automatic connection that names a connection", () => {
    const parsed = workflowActionInputSchema.safeParse({
      connectionId: CONNECTION_ID,
      automaticConnection: true,
      type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
      config: { instruction: "Summarize." },
      events: [WorkflowRunEvent.ExecuteCompleted],
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses workflow.triggered on a post action", () => {
    const parsed = workflowActionInputSchema.safeParse({
      connectionId: CONNECTION_ID,
      type: "jira.add_comment",
      events: ["run.triggered"],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("workflowInstructionRunDetailSchema", () => {
  it("reads back what an instruction's agent did", () => {
    const detail = {
      note: "Moved the issue.",
      operations: [
        {
          type: "jira.transition_issue",
          config: { status: "In Progress", nested: { ok: true } },
          status: WorkflowInstructionOperationStatus.Succeeded,
          externalRef: "In Progress",
          error: null,
        },
      ],
      costUsd: null,
      inputTokens: 1200,
      outputTokens: 40,
    };

    expect(workflowInstructionRunDetailSchema.parse(detail)).toEqual(detail);
    expect(
      workflowInstructionRunDetailSchema.safeParse({ ...detail, operations: 3 })
        .success
    ).toBe(false);
  });
});
