import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { Result } from "@repo/api/src/types/result";
import { WorkflowRunStatus } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionWithItem,
  runLoopState as loop,
  NOW,
} from "@/lib/workflows/__tests__/support/advance.test-helpers";
import {
  type AdvanceDbFake,
  AGENT_CONFIG,
  COMPUTE_TARGET_ID,
  createAdvanceDbFake,
  FEATURE_DOCUMENT_ID,
  PLAN_DOCUMENT_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
  RUN_ID,
} from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { advanceRun } from "@/lib/workflows/engine/advance";
import type { RunLoopState } from "@/lib/workflows/engine/run-loops";
import { SourceClassificationKind } from "@/lib/workflows/engine/source-classification";

/**
 * The ingesting step with a PRD instruction (docs/workflows.md "PRD or
 * Issue"): the run waits for its computer's decision before the item is
 * imported, without fetching the item again meanwhile, then imports it as the
 * decided type.
 */

const mocks = vi.hoisted(() => ({
  fake: null as AdvanceDbFake | null,
  readSourceClassification: vi.fn(),
  requestSourceClassification: vi.fn(),
  ensureRunDocuments: vi.fn(),
  launchWorkflowLoop: vi.fn(),
  findLatestRunLoop: vi.fn(),
  loadConnectionRuntime: vi.fn(),
  enqueueRunEvents: vi.fn(),
  hasEnabledPreActions: vi.fn(),
  hasPostEvents: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/advance-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb, Prisma: { DbNull: support.PRISMA_DB_NULL } };
});
vi.mock(
  "@/lib/workflows/engine/source-classification",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/lib/workflows/engine/source-classification")
      >();
    return {
      ...original,
      readSourceClassification: mocks.readSourceClassification,
      requestSourceClassification: mocks.requestSourceClassification,
    };
  }
);
vi.mock("@/lib/workflows/engine/documents", () => ({
  ensureRunDocuments: mocks.ensureRunDocuments,
  approvePlanDocument: vi.fn(),
  markIssueInReview: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/launch", () => ({
  launchWorkflowLoop: mocks.launchWorkflowLoop,
}));
vi.mock("@/lib/workflows/engine/launch-step", () => ({
  launchStepLoop: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/run-loops")>();
  return { ...original, findLatestRunLoop: mocks.findLatestRunLoop };
});
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/workflows/engine/actions", () => ({
  enqueueRunEvents: mocks.enqueueRunEvents,
  drainActionRuns: vi.fn(),
  hasEnabledPreActions: mocks.hasEnabledPreActions,
  hasPostEvents: mocks.hasPostEvents,
  skipUnfinishedPreActionRuns: vi.fn(),
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));

const INSTRUCTION = "PRD when the item is a Feature labelled PRD.";

let fake: AdvanceDbFake;
/** The PLAN loop the run launched, once it did. */
let planLoop: RunLoopState | null;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createAdvanceDbFake();
  mocks.fake = fake;
  fake.setRun({
    status: WorkflowRunStatus.Ingesting,
    agentConfig: { ...AGENT_CONFIG, prd: { instruction: INSTRUCTION } },
  });
  mocks.ensureRunDocuments.mockResolvedValue(
    Result.ok({
      featureDocumentId: FEATURE_DOCUMENT_ID,
      planDocumentId: PLAN_DOCUMENT_ID,
    })
  );
  planLoop = null;
  mocks.launchWorkflowLoop.mockImplementation(() => {
    planLoop = loop({ command: LoopCommand.Plan, status: LoopStatus.Pending });
    return Promise.resolve(
      Result.ok({ loopId: planLoop.loopId, computeTargetId: COMPUTE_TARGET_ID })
    );
  });
  mocks.findLatestRunLoop.mockImplementation(() => Promise.resolve(planLoop));
  mocks.loadConnectionRuntime.mockResolvedValue(connectionWithItem());
  mocks.enqueueRunEvents.mockResolvedValue(1);
  mocks.hasEnabledPreActions.mockResolvedValue(false);
  mocks.hasPostEvents.mockReturnValue(false);
});

describe("ingesting with a PRD instruction", () => {
  it("waits for the computer's decision without fetching the item again", async () => {
    mocks.readSourceClassification.mockResolvedValue({
      kind: SourceClassificationKind.Waiting,
    });

    await advanceRun(RUN_ID, NOW);

    expect(status()).toBe(WorkflowRunStatus.Ingesting);
    expect(mocks.readSourceClassification).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: INSTRUCTION, now: NOW })
    );
    expect(mocks.loadConnectionRuntime).not.toHaveBeenCalled();
    expect(mocks.ensureRunDocuments).not.toHaveBeenCalled();
  });

  it("asks the computer about a new item and waits for it", async () => {
    mocks.readSourceClassification.mockResolvedValue({
      kind: SourceClassificationKind.None,
      instruction: INSTRUCTION,
    });
    mocks.requestSourceClassification.mockResolvedValue(null);

    await advanceRun(RUN_ID, NOW);

    expect(status()).toBe(WorkflowRunStatus.Ingesting);
    expect(mocks.requestSourceClassification).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: RUN_ID, projectId: PROJECT_ID }),
      workflowName: "Jira to PR",
      instruction: INSTRUCTION,
      item: expect.objectContaining({ key: "PROJ-7" }),
      runAsUserId: RUN_AS_USER_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      now: NOW,
    });
    expect(mocks.ensureRunDocuments).not.toHaveBeenCalled();
  });

  it("imports the item as the decided PRD and plans from it", async () => {
    mocks.readSourceClassification.mockResolvedValue({
      kind: SourceClassificationKind.Decided,
      type: DocumentType.Prd,
    });

    await advanceRun(RUN_ID, NOW);

    expect(mocks.requestSourceClassification).not.toHaveBeenCalled();
    expect(mocks.ensureRunDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: DocumentType.Prd })
    );
    expect(mocks.launchWorkflowLoop).toHaveBeenCalledWith(
      expect.objectContaining({ command: LoopCommand.Plan })
    );
    expect(status()).toBe(WorkflowRunStatus.Planning);
  });

  it("imports an Issue when the computer could not be asked", async () => {
    mocks.readSourceClassification.mockResolvedValue({
      kind: SourceClassificationKind.None,
      instruction: INSTRUCTION,
    });
    mocks.requestSourceClassification.mockResolvedValue(DocumentType.Feature);

    await advanceRun(RUN_ID, NOW);

    expect(mocks.ensureRunDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: DocumentType.Feature })
    );
    expect(status()).toBe(WorkflowRunStatus.Planning);
  });
});

function status(): string | undefined {
  return fake.state.run?.status;
}
