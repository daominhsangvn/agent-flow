import {
  ProcessStepRole,
  ProcessStepType,
  type ProjectProcessInput,
  projectProcessSchema,
  ReviewDecisionKind,
  ReviewSignalVia,
} from "@repo/api/src/types/project-process";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import { conditionsReviewSignal } from "@/lib/integrations/trigger-conditions";
import type { InboundEvent } from "@/lib/integrations/types";
import { routeReviewSignals } from "@/lib/workflows/engine/review-signals";

/**
 * Signals from the source item to a waiting run (engine/review-signals.ts):
 * labels and mentions decide the review or the approval the run waits on,
 * or are queued while its step works, and never decide twice.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      workflowRun: {
        findMany: mocks.findMany,
        updateMany: mocks.updateMany,
      },
    }),
  Prisma: { DbNull: "__db_null__" },
}));

const CONDITIONS = "jira.issue_conditions";

const CONNECTION = {
  record: { organizationId: "org-1" },
  provider: {
    reviewSignal: conditionsReviewSignal({
      triggerType: CONDITIONS,
      addedLabelsAttribute: "addedLabels",
      mentionedAttribute: "mentioned",
    }),
  },
} as unknown as LoadedConnection;

const REVIEWED: ProjectProcessInput = {
  toolkit: null,
  steps: [
    {
      type: ProcessStepType.Agent,
      id: "plan",
      name: "Plan",
      instruction: "/plan",
      role: ProcessStepRole.Plan,
      review: {
        approve: { labels: ["plan-approved"] },
        feedback: { labels: ["replan"], mention: true },
      },
    },
    {
      type: ProcessStepType.Approval,
      id: "approve-release",
      name: "Approve the release",
      approve: { labels: ["ship-it"] },
    },
  ],
};

const WAITING_REVIEW = {
  waiting: null,
  approval: null,
  review: {
    stepId: "plan",
    loopId: "loop-1",
    round: 1,
    requestedAt: "2026-10-15T09:00:00.000Z",
    decision: null,
    history: [],
  },
};

function event(
  attributes: Record<string, unknown>,
  dedupKey = "PROJ-7:conditions:1"
) {
  return {
    triggerType: CONDITIONS,
    dedupKey,
    occurredAt: new Date("2026-10-15T10:00:00.000Z"),
    actor: { id: "acc-1", displayName: "Bea" },
    item: {
      provider: "jira",
      externalId: "10007",
      key: "PROJ-7",
      url: null,
      title: null,
      container: "PROJ",
    },
    attributes: { addedLabels: [], mentioned: false, ...attributes },
  } as InboundEvent;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    workflowId: "wf-1",
    status: WorkflowRunStatus.NeedsApproval,
    stepId: "plan",
    process: {
      version: 1,
      source: "workflow",
      definition: projectProcessSchema.parse(REVIEWED),
    },
    stepState: WAITING_REVIEW,
    occurrenceKeys: [],
    ...overrides,
  };
}

function route(signal: InboundEvent) {
  return routeReviewSignals({
    connection: CONNECTION,
    event: signal,
    projectConnectionId: "pc-1",
    sourceKey: "jira:PROJ-7",
  });
}

function writtenState() {
  return mocks.updateMany.mock.calls[0]?.[0]?.data?.stepState;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("routeReviewSignals", () => {
  it("decides the waiting review with an approve label", async () => {
    mocks.findMany.mockResolvedValue([run()]);

    const signalled = await route(event({ addedLabels: ["Plan-Approved"] }));

    expect(signalled).toEqual([{ runId: "run-1", workflowId: "wf-1" }]);
    expect(mocks.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      organizationId: "org-1",
      projectConnectionId: "pc-1",
      sourceKey: "jira:PROJ-7",
      status: {
        in: [
          WorkflowRunStatus.NeedsApproval,
          WorkflowRunStatus.Running,
          WorkflowRunStatus.Planning,
          WorkflowRunStatus.Executing,
        ],
      },
    });
    expect(mocks.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "run-1", status: WorkflowRunStatus.NeedsApproval },
      data: { occurrenceKeys: { push: "PROJ-7:conditions:1" } },
    });
    expect(writtenState().review.decision).toEqual({
      kind: ReviewDecisionKind.Approve,
      via: ReviewSignalVia.Label,
      label: "plan-approved",
      text: "",
      by: null,
      author: "Bea",
      at: "2026-10-15T10:00:00.000Z",
    });
  });

  it("takes a comment that mentions the bot as feedback", async () => {
    mocks.findMany.mockResolvedValue([run()]);

    await route(event({ mentioned: true }));

    expect(writtenState().review.decision).toMatchObject({
      kind: ReviewDecisionKind.Feedback,
      via: ReviewSignalVia.Mention,
      label: null,
    });
  });

  it("queues a signal while the step still works", async () => {
    mocks.findMany.mockResolvedValue([
      run({ status: WorkflowRunStatus.Running, stepState: null }),
    ]);

    await route(event({ addedLabels: ["replan"] }));

    expect(mocks.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      stepState: { equals: "__db_null__" },
    });
    expect(writtenState().pendingSignals).toEqual([
      expect.objectContaining({
        kind: ReviewDecisionKind.Feedback,
        label: "replan",
      }),
    ]);
  });

  it("approves a waiting approval step with its label", async () => {
    mocks.findMany.mockResolvedValue([
      run({
        stepId: "approve-release",
        stepState: {
          waiting: null,
          approval: {
            stepId: "approve-release",
            requestedAt: "2026-10-15T09:00:00.000Z",
            decision: null,
          },
        },
      }),
    ]);

    await route(event({ addedLabels: ["ship-it"] }));

    expect(writtenState().approval.decision).toEqual({
      approved: true,
      comment: 'Approved with the label "ship-it" by Bea.',
      decidedBy: null,
      decidedAt: "2026-10-15T10:00:00.000Z",
    });
  });

  it("ignores an approve and a feedback label added at once", async () => {
    mocks.findMany.mockResolvedValue([run()]);

    const signalled = await route(
      event({ addedLabels: ["plan-approved", "replan"] })
    );

    expect(signalled).toEqual([]);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not decide twice: a seen occurrence, a decided review, a run that moved on", async () => {
    mocks.findMany.mockResolvedValue([
      run({ occurrenceKeys: ["PROJ-7:conditions:1"] }),
      run({
        id: "run-2",
        stepState: {
          ...WAITING_REVIEW,
          review: {
            ...WAITING_REVIEW.review,
            decision: {
              kind: ReviewDecisionKind.Approve,
              via: ReviewSignalVia.App,
              text: "",
              by: "user-1",
              author: null,
              label: null,
              at: "2026-10-15T09:30:00.000Z",
            },
          },
        },
      }),
    ]);

    expect(await route(event({ addedLabels: ["plan-approved"] }))).toEqual([]);
    expect(mocks.updateMany).not.toHaveBeenCalled();

    mocks.findMany.mockResolvedValue([run()]);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await route(event({ addedLabels: ["plan-approved"] }))).toEqual([]);
  });

  it("looks nothing up for an event that is no signal", async () => {
    expect(await route(event({}))).toEqual([]);
    expect(
      await route({
        ...event({ mentioned: true }),
        triggerType: "jira.issue_mentioned",
      })
    ).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
