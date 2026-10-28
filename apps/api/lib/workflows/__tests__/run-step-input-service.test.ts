import {
  ReviewDecisionKind,
  ReviewSignalVia,
} from "@repo/api/src/types/project-process";
import { Status } from "@repo/api/src/types/result";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowRunStepInputService } from "@/lib/workflows/run-step-input-service";

/**
 * Answers and approval decisions on a run waiting on a process step: they
 * are recorded on the run's step state only while the run still waits there
 * (status and step state unchanged), then the run is advanced.
 */

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const RUN_ID = "0199a5f0-0000-7000-8000-0000000000b1";
const USER_ID = "user-1";

const mocks = vi.hoisted(() => ({
  db: { workflowRun: { findFirst: vi.fn(), updateMany: vi.fn() } },
  advanceRun: vi.fn(),
  getRun: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(mocks.db),
}));
vi.mock("@/lib/workflows/engine/advance", () => ({
  advanceRun: mocks.advanceRun,
}));
vi.mock("@/lib/workflows/run-service", () => ({
  workflowRunService: { get: mocks.getRun },
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));

const WAITING = {
  waiting: {
    stepId: "clarify",
    loopId: "loop-2",
    questions: [
      { id: "q1", question: "CSV or TSV?" },
      { id: "q2", question: "Which columns?" },
    ],
    askedAt: "2026-10-01T00:00:00.000Z",
    answers: null,
    answeredBy: null,
  },
  approval: null,
};

const AWAITING_APPROVAL = {
  waiting: null,
  approval: {
    stepId: "review",
    requestedAt: "2026-10-01T00:00:00.000Z",
    decision: null,
  },
};

function storedRun(status: string, stepState: unknown) {
  mocks.db.workflowRun.findFirst.mockResolvedValue({
    id: RUN_ID,
    status,
    stepState,
  });
}

function updateArgs() {
  return mocks.db.workflowRun.updateMany.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.workflowRun.updateMany.mockResolvedValue({ count: 1 });
  mocks.advanceRun.mockResolvedValue("advanced");
  mocks.getRun.mockResolvedValue({ id: RUN_ID });
});

describe("answerQuestions", () => {
  it("records the answers while the run still waits, then advances it", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, WAITING);

    const result = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q1", answer: "CSV" }] }
    );

    expect(result).toEqual({ ok: true, value: { id: RUN_ID } });
    expect(updateArgs()).toEqual({
      where: {
        id: RUN_ID,
        organizationId: ORG_ID,
        status: WorkflowRunStatus.NeedsInput,
        stepState: { equals: WAITING },
      },
      data: {
        stepState: {
          ...WAITING,
          waiting: {
            ...WAITING.waiting,
            answers: [{ id: "q1", answer: "CSV" }],
            answeredBy: USER_ID,
          },
        },
        nextStepAt: null,
      },
    });
    expect(mocks.advanceRun).toHaveBeenCalledWith(RUN_ID);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("refuses a run that does not wait for answers", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, null);

    const result = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q1", answer: "CSV" }] }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        status: Status.Conflict,
        message: "The run is not waiting for answers.",
      },
    });
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it("refuses questions answered already", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, {
      ...WAITING,
      waiting: {
        ...WAITING.waiting,
        answers: [{ id: "q1", answer: "TSV" }],
        answeredBy: "user-2",
      },
    });

    const result = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q1", answer: "CSV" }] }
    );

    expect(!result.ok && result.error.status).toBe(Status.Conflict);
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it("rejects unknown and repeated questions", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, WAITING);

    const unknown = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q9", answer: "?" }] }
    );
    const repeated = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      {
        answers: [
          { id: "q1", answer: "CSV" },
          { id: "q1", answer: "TSV" },
        ],
      }
    );

    expect(!unknown.ok && unknown.error).toEqual({
      status: Status.BadRequest,
      message: "Unknown question: q9",
    });
    expect(!repeated.ok && repeated.error.status).toBe(Status.BadRequest);
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it("reports a conflict when the run moved on in the meantime", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, WAITING);
    mocks.db.workflowRun.updateMany.mockResolvedValue({ count: 0 });

    const result = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q1", answer: "CSV" }] }
    );

    expect(!result.ok && result.error.status).toBe(Status.Conflict);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("answers 404 for a run of another organization or a malformed id", async () => {
    mocks.db.workflowRun.findFirst.mockResolvedValue(null);

    const missing = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { answers: [{ id: "q1", answer: "CSV" }] }
    );
    const malformed = await workflowRunStepInputService.answerQuestions(
      ORG_ID,
      USER_ID,
      "not-a-uuid",
      { answers: [{ id: "q1", answer: "CSV" }] }
    );

    expect(!missing.ok && missing.error.status).toBe(Status.NotFound);
    expect(!malformed.ok && malformed.error.status).toBe(Status.NotFound);
    expect(mocks.db.workflowRun.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.db.workflowRun.findFirst).toHaveBeenCalledWith({
      where: { id: RUN_ID, organizationId: ORG_ID },
      select: { id: true, status: true, stepState: true },
    });
  });
});

describe("decideApproval", () => {
  it("records the decision while the run still waits, then advances it", async () => {
    storedRun(WorkflowRunStatus.NeedsApproval, AWAITING_APPROVAL);

    const result = await workflowRunStepInputService.decideApproval(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { approved: false, comment: "Too broad." }
    );

    expect(result.ok).toBe(true);
    expect(updateArgs()).toEqual({
      where: {
        id: RUN_ID,
        organizationId: ORG_ID,
        status: WorkflowRunStatus.NeedsApproval,
        stepState: { equals: AWAITING_APPROVAL },
      },
      data: {
        stepState: {
          waiting: null,
          approval: {
            ...AWAITING_APPROVAL.approval,
            decision: {
              approved: false,
              comment: "Too broad.",
              decidedBy: USER_ID,
              decidedAt: expect.any(String),
            },
          },
        },
        nextStepAt: null,
      },
    });
    expect(mocks.advanceRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("refuses a run that does not wait for an approval", async () => {
    storedRun(WorkflowRunStatus.NeedsInput, WAITING);

    const result = await workflowRunStepInputService.decideApproval(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { approved: true, comment: "" }
    );

    expect(!result.ok && result.error).toEqual({
      status: Status.Conflict,
      message: "The run is not waiting for an approval.",
    });
  });

  it("refuses a step decided already", async () => {
    storedRun(WorkflowRunStatus.NeedsApproval, {
      ...AWAITING_APPROVAL,
      approval: {
        ...AWAITING_APPROVAL.approval,
        decision: {
          approved: true,
          comment: "",
          decidedBy: "user-2",
          decidedAt: "2026-10-01T00:01:00.000Z",
        },
      },
    });

    const result = await workflowRunStepInputService.decideApproval(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { approved: false, comment: "" }
    );

    expect(!result.ok && result.error.status).toBe(Status.Conflict);
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });
});

const AWAITING_REVIEW = {
  waiting: null,
  approval: null,
  review: {
    stepId: "plan",
    loopId: "loop-1",
    round: 2,
    requestedAt: "2026-10-01T00:00:00.000Z",
    decision: null,
    history: [],
  },
};

describe("decideReview", () => {
  it("records the decision in AgentFlow while the run still waits, then advances it", async () => {
    storedRun(WorkflowRunStatus.NeedsApproval, AWAITING_REVIEW);

    const result = await workflowRunStepInputService.decideReview(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { decision: ReviewDecisionKind.Feedback, comment: "Split the task" }
    );

    expect(result).toEqual({ ok: true, value: { id: RUN_ID } });
    expect(updateArgs()).toMatchObject({
      where: {
        id: RUN_ID,
        organizationId: ORG_ID,
        status: WorkflowRunStatus.NeedsApproval,
        stepState: { equals: AWAITING_REVIEW },
      },
      data: {
        stepState: {
          review: {
            round: 2,
            decision: {
              kind: ReviewDecisionKind.Feedback,
              via: ReviewSignalVia.App,
              text: "Split the task",
              by: USER_ID,
              author: null,
              label: null,
            },
          },
        },
      },
    });
    expect(mocks.waitUntil).toHaveBeenCalled();
  });

  it("refuses a run that does not wait for a review, or one decided already", async () => {
    storedRun(WorkflowRunStatus.NeedsApproval, AWAITING_APPROVAL);
    const notWaiting = await workflowRunStepInputService.decideReview(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { decision: ReviewDecisionKind.Approve, comment: "" }
    );
    storedRun(WorkflowRunStatus.NeedsApproval, {
      ...AWAITING_REVIEW,
      review: {
        ...AWAITING_REVIEW.review,
        decision: {
          kind: ReviewDecisionKind.Approve,
          via: ReviewSignalVia.Label,
          text: "",
          by: null,
          author: "Bea",
          label: "plan-approved",
          at: "2026-10-01T00:05:00.000Z",
        },
      },
    });
    const decided = await workflowRunStepInputService.decideReview(
      ORG_ID,
      USER_ID,
      RUN_ID,
      { decision: ReviewDecisionKind.Reject, comment: "" }
    );

    expect(notWaiting).toMatchObject({
      ok: false,
      error: { status: Status.Conflict },
    });
    expect(decided).toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        message: "The review was already decided.",
      },
    });
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });
});
