import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  WorkflowRunSourceClassificationOrigin,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceItem } from "@/lib/integrations/types";
import {
  CLASSIFICATION_MAX_WAIT_MS,
  readSourceClassification,
  requestSourceClassification,
  SourceClassificationKind,
} from "@/lib/workflows/engine/source-classification";
import { toSourceClassificationView } from "@/lib/workflows/engine/source-classification-record";

/**
 * PRD or Issue (engine/source-classification.ts): the run's computer reads
 * the workflow's PRD instruction and the item once, the decision is stored
 * on the run, and anything but a clear answer makes the item an Issue.
 */

const mocks = vi.hoisted(() => ({
  db: {
    workflowRun: { findFirst: vi.fn(), updateMany: vi.fn() },
  },
  getCommandById: vi.fn(),
  getCommandEvents: vi.fn(),
  markCommandExpired: vi.fn(),
  dispatchWorkflowDecision: vi.fn(),
  resolveProjectComputeTarget: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(mocks.db),
}));
vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: mocks.getCommandById,
    getCommandEvents: mocks.getCommandEvents,
    markCommandExpired: mocks.markCommandExpired,
  },
}));
vi.mock("@/lib/loops/loop-desktop", () => ({
  dispatchWorkflowDecision: mocks.dispatchWorkflowDecision,
}));
vi.mock("@/lib/workflows/engine/launch", () => ({
  resolveProjectComputeTarget: mocks.resolveProjectComputeTarget,
}));

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const RUN_ID = "0199a5f0-0000-7000-8000-0000000000a1";
const PROJECT = "0199a5f0-0000-7000-8000-0000000000b1";
const USER = "0199a5f0-0000-7000-8000-0000000000c1";
const WORKFLOW_COMPUTER = "0199a5f0-0000-7000-8000-0000000000d1";
const RUNNER = "0199a5f0-0000-7000-8000-0000000000d2";
const COMMAND = "0199a5f0-0000-7000-8000-0000000000e1";
const NOW = new Date("2026-10-13T09:00:00.000Z");
const REQUESTED_AT = new Date("2026-10-13T08:59:00.000Z");
const INSTRUCTION =
  "PRD when the type is Feature or User Story and it has the label PRD.";
const RUN = { id: RUN_ID, organizationId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.workflowRun.findFirst.mockResolvedValue(null);
  mocks.db.workflowRun.updateMany.mockResolvedValue({ count: 1 });
  mocks.getCommandEvents.mockResolvedValue([]);
  mocks.resolveProjectComputeTarget.mockResolvedValue(Result.ok(RUNNER));
  mocks.dispatchWorkflowDecision.mockResolvedValue(COMMAND);
});

describe("readSourceClassification", () => {
  it("makes every item an Issue without an instruction, asking no one", async () => {
    const state = await readSourceClassification({
      run: RUN,
      instruction: null,
      now: NOW,
    });

    expect(state).toEqual({
      kind: SourceClassificationKind.Decided,
      type: DocumentType.Feature,
    });
    expect(mocks.db.workflowRun.findFirst).not.toHaveBeenCalled();
  });

  it("has nothing yet before the computer was asked", async () => {
    expect(await read()).toEqual({
      kind: SourceClassificationKind.None,
      instruction: INSTRUCTION,
    });
  });

  it("keeps a stored decision", async () => {
    stored(decision(DocumentType.Prd));

    expect(await read()).toEqual({
      kind: SourceClassificationKind.Decided,
      type: DocumentType.Prd,
    });
    expect(mocks.getCommandById).not.toHaveBeenCalled();
  });

  it("waits while the computer decides", async () => {
    stored(pending());
    command(DesktopCommandStatus.Running);

    expect(await read()).toEqual({ kind: SourceClassificationKind.Waiting });
    expect(mocks.db.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it("stores the computer's PRD decision with its reason and cost", async () => {
    stored(pending());
    answered('{"type": "PRD", "reason": "A Feature labelled PRD."}', 0.0021);

    expect(await read()).toEqual({
      kind: SourceClassificationKind.Decided,
      type: DocumentType.Prd,
    });
    expect(saved()).toEqual({
      status: "decided",
      type: DocumentType.Prd,
      origin: WorkflowRunSourceClassificationOrigin.Instruction,
      reason: "A Feature labelled PRD.",
      costUsd: 0.0021,
      decidedAt: NOW.toISOString(),
    });
    expect(lastWrite().where).toEqual({ id: RUN_ID, organizationId: ORG });
  });

  it("reads an answer inside a code fence", async () => {
    stored(pending());
    answered(
      '```json\n{"type": "issue", "reason": "It is a bug report."}\n```'
    );

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Instruction,
      reason: "It is a bug report.",
    });
  });

  it("makes the item an Issue when the answer is not a decision", async () => {
    stored(pending());
    answered("It looks like a product requirement to me.");

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(saved()).toMatchObject({
      type: DocumentType.Feature,
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason:
        "The answer was not a PRD or Issue decision: It looks like a product requirement to me.",
    });
  });

  it("makes the item an Issue when the computer could not decide", async () => {
    stored(pending());
    answeredWith({
      type: "result",
      ok: false,
      error: "Claude Code failed: authentication_error",
    });

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason:
        "The run's computer could not decide: Claude Code failed: authentication_error",
    });
  });

  it("makes the item an Issue when the computer finished without an answer", async () => {
    stored(pending());
    command(DesktopCommandStatus.Done);

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason: "The run's computer finished the decision without an answer.",
    });
  });

  it("makes the item an Issue when the command failed", async () => {
    stored(pending());
    command(DesktopCommandStatus.Failed, "operationId/path mismatch");

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason:
        "The run's computer did not run the decision (failed: operationId/path mismatch).",
    });
  });

  it("expires an overdue command and makes the item an Issue", async () => {
    stored(pending(new Date(NOW.getTime() - CLASSIFICATION_MAX_WAIT_MS - 1)));
    command(DesktopCommandStatus.Queued);

    expect(await read()).toMatchObject({ type: DocumentType.Feature });
    expect(mocks.markCommandExpired).toHaveBeenCalledWith(
      COMMAND,
      "workflow_decision_wait_exceeded",
      expect.objectContaining({ commandId: COMMAND })
    );
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
    });
  });
});

describe("requestSourceClassification", () => {
  it("asks the project's computer with the instruction and the item, then waits", async () => {
    const type = await requestSourceClassification(request());

    expect(type).toBeNull();
    expect(mocks.resolveProjectComputeTarget).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      projectId: PROJECT,
      computeTargetId: WORKFLOW_COMPUTER,
    });
    const [{ computeTargetId, request: sent }] =
      mocks.dispatchWorkflowDecision.mock.calls[0] ?? [];
    expect(computeTargetId).toBe(RUNNER);
    expect(sent.decisionId).toBe(RUN_ID);
    expect(sent.prompt).toContain(INSTRUCTION);
    expect(sent.prompt).toContain("- Type: Feature");
    expect(sent.prompt).toContain("- Labels: ai-ready, PRD");
    expect(sent.prompt).toContain("Let people use the calculator");
    expect(sent.prompt).toContain('{"type": "prd", "reason": "..."}');
    expect(saved()).toEqual({
      status: "pending",
      commandId: COMMAND,
      requestedAt: NOW.toISOString(),
    });
  });

  it("makes the item an Issue when no computer can decide", async () => {
    mocks.resolveProjectComputeTarget.mockResolvedValue(
      Result.err({
        code: WorkflowRunErrorCode.ComputeTargetUnavailable,
        message: "None of the project's runners is online.",
      })
    );

    expect(await requestSourceClassification(request())).toBe(
      DocumentType.Feature
    );
    expect(mocks.dispatchWorkflowDecision).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason:
        "No computer could decide: None of the project's runners is online.",
    });
  });

  it("makes the item an Issue when the computer cannot be asked", async () => {
    mocks.dispatchWorkflowDecision.mockRejectedValue(new Error("relay down"));

    expect(await requestSourceClassification(request())).toBe(
      DocumentType.Feature
    );
    expect(saved()).toMatchObject({
      origin: WorkflowRunSourceClassificationOrigin.Fallback,
      reason: "The run's computer could not be asked: relay down",
    });
  });
});

describe("toSourceClassificationView", () => {
  it("shows a decision and nothing while the computer decides", () => {
    expect(toSourceClassificationView(decision(DocumentType.Prd))).toEqual({
      type: DocumentType.Prd,
      origin: WorkflowRunSourceClassificationOrigin.Instruction,
      reason: "A Feature labelled PRD.",
    });
    expect(toSourceClassificationView(pending())).toBeNull();
    expect(toSourceClassificationView(null)).toBeNull();
  });
});

function read() {
  return readSourceClassification({
    run: RUN,
    instruction: INSTRUCTION,
    now: NOW,
  });
}

function request() {
  return {
    run: { ...RUN, projectId: PROJECT },
    workflowName: "Calculator",
    instruction: INSTRUCTION,
    item: sourceItem(),
    runAsUserId: USER,
    computeTargetId: WORKFLOW_COMPUTER,
    now: NOW,
  };
}

function stored(value: unknown): void {
  mocks.db.workflowRun.findFirst.mockResolvedValue({
    sourceClassification: value,
  });
}

function pending(requestedAt: Date = REQUESTED_AT) {
  return {
    status: "pending",
    commandId: COMMAND,
    requestedAt: requestedAt.toISOString(),
  };
}

function decision(type: string) {
  return {
    status: "decided",
    type,
    origin: WorkflowRunSourceClassificationOrigin.Instruction,
    reason: "A Feature labelled PRD.",
    costUsd: null,
    decidedAt: REQUESTED_AT.toISOString(),
  };
}

function command(status: DesktopCommandStatus, error?: string): void {
  mocks.getCommandById.mockResolvedValue({
    commandId: COMMAND,
    computeTargetId: RUNNER,
    operationId: "workflow_decision",
    status,
    error,
    createdAt: REQUESTED_AT.toISOString(),
    lastSequenceAcked: 0,
  });
}

function answered(answer: string, costUsd: number | null = null): void {
  answeredWith({ type: "result", ok: true, answer, costUsd });
}

function answeredWith(data: unknown): void {
  command(DesktopCommandStatus.Done);
  mocks.getCommandEvents.mockResolvedValue([
    { commandId: COMMAND, sequence: 1, eventType: "status", data: {} },
    { commandId: COMMAND, sequence: 2, eventType: "result", data },
    { commandId: COMMAND, sequence: 3, eventType: "done", data: {} },
  ]);
}

/** The last write to the run: which run, and the classification it stored. */
function lastWrite(): { where: unknown; classification: unknown } {
  const [args] = mocks.db.workflowRun.updateMany.mock.calls.at(-1) ?? [];
  return {
    where: args?.where,
    classification: args?.data.sourceClassification,
  };
}

function saved(): unknown {
  return lastWrite().classification;
}

function sourceItem(): SourceItem {
  return {
    provider: IntegrationProviderKey.Jira,
    externalId: "10006",
    key: "SCRUM-6",
    url: "https://acme.atlassian.net/browse/SCRUM-6",
    title: "Calculator keyboard support",
    container: "SCRUM",
    bodyMarkdown: "## Goal\nLet people use the calculator from a keyboard.",
    itemType: "Feature",
    status: "To Do",
    priority: "Medium",
    labels: ["ai-ready", "PRD"],
    reporter: null,
    assignee: null,
    sections: [],
    comments: [],
    attachments: [],
  };
}
