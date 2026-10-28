import { describe, expect, it } from "vitest";
import {
  type AgentProcessStep,
  agentStepFinish,
  ProcessDocumentType,
  ProcessStepFinish,
  ProcessStepRole,
  ProcessStepType,
  type ProjectProcessInput,
  processHasPlanStep,
  projectProcessSchema,
  ReviewSession,
  writesReleaseNotes,
} from "./project-process.ts";

/** Step roles (docs/workflows.md "Step roles"): the rules a process must follow. */

const PLAN = {
  type: ProcessStepType.Agent,
  id: "plan",
  name: "Plan",
  instruction: "/plan-ticket {{issue.key}}",
  role: ProcessStepRole.Plan,
};

const IMPLEMENT = {
  type: ProcessStepType.Agent,
  id: "implement",
  name: "Implement",
  instruction: "/implement-ticket",
  role: ProcessStepRole.Implement,
};

function issues(process: ProjectProcessInput) {
  const parsed = projectProcessSchema.safeParse(process);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
}

/** One agent step, parsed after a plan step so every role is valid. */
function parseStep(step: object): AgentProcessStep {
  const parsed = projectProcessSchema.parse({
    toolkit: null,
    steps: [PLAN, step],
  }).steps[1];
  if (parsed?.type !== ProcessStepType.Agent) {
    throw new Error("agent step expected");
  }
  return parsed;
}

describe("step roles", () => {
  it("accepts a plan step followed by an implement step", () => {
    const process = projectProcessSchema.parse({
      toolkit: null,
      steps: [PLAN, IMPLEMENT],
    });

    expect(processHasPlanStep(process)).toBe(true);
  });

  it("accepts an implement step after the AgentFlow plan step", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          { type: ProcessStepType.AgentFlowPlan, id: "plan", name: "Plan" },
          IMPLEMENT,
        ],
      })
    ).toEqual([]);
  });

  it("rejects an implement step without a plan step before it", () => {
    expect(issues({ toolkit: null, steps: [IMPLEMENT, PLAN] })).toEqual([
      {
        path: "steps.0.role",
        message:
          "A step with role: implement needs a plan step before it (an AgentFlow plan step or a step with role: plan)",
      },
    ]);
  });

  it("rejects a second plan step, of either kind", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          { type: ProcessStepType.AgentFlowPlan, id: "draft", name: "Draft" },
          PLAN,
        ],
      })
    ).toEqual([
      {
        path: "steps.1.role",
        message:
          "A process has at most one plan step (an AgentFlow plan step or a step with role: plan)",
      },
    ]);
  });

  it("rejects an Implementation Plan document on a plan step", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          {
            ...PLAN,
            document: {
              type: ProcessDocumentType.ImplementationPlan,
              path: "plan.md",
            },
          },
        ],
      })
    ).toEqual([
      {
        path: "steps.0.document.type",
        message:
          "A step with role: plan already writes the run's implementation plan; remove its IMPLEMENTATION_PLAN document",
      },
    ]);
  });

  it("rejects releaseNotes on a step that does not implement", () => {
    expect(
      issues({ toolkit: null, steps: [{ ...PLAN, releaseNotes: true }] })
    ).toEqual([
      {
        path: "steps.0.releaseNotes",
        message: "releaseNotes applies to steps with role: implement",
      },
    ]);
  });

  it("makes an implement step push and write release notes unless turned off", () => {
    const implement = parseStep({ ...IMPLEMENT, finish: "none" });

    expect(agentStepFinish(implement)).toBe(ProcessStepFinish.Push);
    expect(writesReleaseNotes(implement)).toBe(true);
    expect(writesReleaseNotes({ ...implement, releaseNotes: false })).toBe(
      false
    );
  });

  it("leaves a step without a role as it is", () => {
    const step = parseStep({
      type: ProcessStepType.Agent,
      id: "notes",
      name: "Notes",
      instruction: "Write notes",
    });

    expect(step.role).toBeUndefined();
    expect(agentStepFinish(step)).toBe(ProcessStepFinish.None);
    expect(writesReleaseNotes(step)).toBe(false);
  });
});

describe("step reviews", () => {
  it("approves a plan step and completes any other", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          {
            ...PLAN,
            review: {
              approve: { labels: ["plan-approved"] },
              feedback: { labels: ["replan"], mention: true },
            },
          },
          { ...IMPLEMENT, review: { complete: { labels: ["done"] } } },
        ],
      })
    ).toEqual([]);
  });

  it("refuses approve off a plan step and complete on one", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          { ...PLAN, review: { complete: { labels: ["done"] } } },
          { ...IMPLEMENT, review: { approve: { labels: ["ok"] } } },
        ],
      })
    ).toEqual([
      {
        path: "steps.0.review.complete",
        message: "A plan step is approved: use review.approve",
      },
      {
        path: "steps.1.review.approve",
        message:
          "review.approve is for a step with role: plan; use review.complete to end the review of another step",
      },
    ]);
  });

  it("refuses a label that signals two things", () => {
    expect(
      issues({
        toolkit: null,
        steps: [
          {
            ...PLAN,
            review: {
              approve: { labels: ["Ready"] },
              feedback: { labels: ["ready"] },
            },
          },
        ],
      })
    ).toEqual([
      {
        path: "steps.0.review",
        message:
          "A label can signal one thing only (approve, complete or feedback)",
      },
    ]);
  });

  it("fills a review's defaults", () => {
    const [plan] = projectProcessSchema.parse({
      toolkit: null,
      steps: [{ ...PLAN, review: {} }],
    }).steps;

    expect(plan?.type === ProcessStepType.Agent ? plan.review : null).toEqual({
      feedback: { labels: [], mention: false },
      session: ReviewSession.Resume,
      consumeLabels: true,
    });
  });
});
