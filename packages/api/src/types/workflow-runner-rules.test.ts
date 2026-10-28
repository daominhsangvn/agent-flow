import { describe, expect, it } from "vitest";
import {
  chooseRunnerByRules,
  evaluateRunnerCondition,
  parseRunnerCondition,
  type WorkflowRunnerConditionFacts,
  WorkflowRunnerConditionField,
  workflowRunnerRuleSchema,
} from "./workflow-runner-rules.ts";

const RUNNER_AN = "01a16128-f37d-7672-af04-62977e1c387c";
const RUNNER_BINH = "01a1612f-c47b-73fe-bf72-32855ed7cf2c";
const RUNNER_SHARED = "01a15478-a214-77a6-938f-c0f516cf3aa1";

const FACTS: WorkflowRunnerConditionFacts = {
  [WorkflowRunnerConditionField.Key]: "BREP-12",
  [WorkflowRunnerConditionField.Type]: "Bug",
  [WorkflowRunnerConditionField.Status]: "Ready for Development",
  [WorkflowRunnerConditionField.Labels]: ["backend", "QA"],
  [WorkflowRunnerConditionField.Assignee]: "Nguyễn Văn An",
  [WorkflowRunnerConditionField.AssigneeEmail]: "An@Acme.dev",
  [WorkflowRunnerConditionField.ReporterEmail]: null,
};

function holds(text: string): boolean {
  const parsed = parseRunnerCondition(text);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return evaluateRunnerCondition(parsed.condition, FACTS);
}

describe("runner conditions", () => {
  it("compares fields ignoring case and spaces", () => {
    expect(holds('source.assignee_email == "an@acme.dev"')).toBe(true);
    expect(holds("source.assignee == ' nguyễn văn an '")).toBe(true);
    expect(holds('source.assignee_email != "binh@acme.dev"')).toBe(true);
    expect(holds('source.status == "Ready for Testing"')).toBe(false);
  });

  it("reads a missing field as empty", () => {
    expect(holds('source.reporter_email == ""')).toBe(true);
    expect(holds('source.priority == "High"')).toBe(false);
  });

  it("checks list membership with contains and in", () => {
    expect(holds('source.labels contains "qa"')).toBe(true);
    expect(holds('source.labels contains "q"')).toBe(false);
    expect(holds('source.title contains ""')).toBe(true);
    expect(holds('source.type in ["Story", "bug"]')).toBe(true);
    expect(holds('source.labels in ["frontend", "backend"]')).toBe(true);
  });

  it("combines comparisons with and, or, not and parentheses", () => {
    expect(
      holds(
        'source.type == "Bug" && (source.labels contains "qa" || source.priority == "High")'
      )
    ).toBe(true);
    expect(holds('not source.type == "Bug" or source.key == "BREP-12"')).toBe(
      true
    );
    expect(holds('!(source.type == "Bug") and source.key == "BREP-12"')).toBe(
      false
    );
  });

  it("names what is wrong", () => {
    expect(parseRunnerCondition('source.user == "x"')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown field "source.user"'),
    });
    expect(parseRunnerCondition('source.type = "Bug"')).toMatchObject({
      ok: false,
    });
    expect(parseRunnerCondition('source.type == "Bug')).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unclosed quote"),
    });
    expect(parseRunnerCondition("source.type ==")).toMatchObject({
      ok: false,
      error: expect.stringContaining("quoted value"),
    });
    expect(
      parseRunnerCondition('source.type == "Bug" source.key == "x"')
    ).toMatchObject({ ok: false });
  });

  it("validates a rule's condition in its schema", () => {
    expect(
      workflowRunnerRuleSchema.safeParse({
        computeTargetId: RUNNER_AN,
        condition: "source.assignee ===",
      }).success
    ).toBe(false);
  });
});

describe("chooseRunnerByRules", () => {
  const rules = [
    {
      computeTargetId: RUNNER_BINH,
      condition: 'source.assignee_email == "binh@acme.dev"',
    },
    {
      computeTargetId: RUNNER_AN,
      condition: 'source.assignee_email == "an@acme.dev"',
    },
    { computeTargetId: RUNNER_BINH, condition: 'source.type == "Bug"' },
  ];

  it("takes the first rule that matches", () => {
    expect(chooseRunnerByRules(rules, FACTS, RUNNER_SHARED)).toEqual({
      computeTargetId: RUNNER_AN,
      ruleIndex: 1,
    });
  });

  it("falls back to the workflow's runner when none matches", () => {
    expect(
      chooseRunnerByRules(
        rules,
        { [WorkflowRunnerConditionField.Type]: "Story" },
        RUNNER_SHARED
      )
    ).toEqual({ computeTargetId: RUNNER_SHARED, ruleIndex: null });
  });
});
