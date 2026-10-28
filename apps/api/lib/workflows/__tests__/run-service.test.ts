import {
  IntegrationConnectionStatus,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import {
  IntegrationToolCallStatus,
  ToolCallDecision,
} from "@repo/api/src/types/integration-tools";
import { ProcessDocumentType } from "@repo/api/src/types/project-process";
import { Result, Status } from "@repo/api/src/types/result";
import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEvent } from "@/lib/workflows/__tests__/support/ingest-db.test-fake";
import { CancelRunFailure } from "@/lib/workflows/engine/advance";
import { IngestDecision } from "@/lib/workflows/engine/ingest";
import { workflowRunService } from "@/lib/workflows/run-service";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  workflow: "0199a5f0-0000-7000-8000-0000000000f1",
  trigger: "0199a5f0-0000-7000-8000-0000000000e1",
  run: "0199a5f0-0000-7000-8000-0000000000b1",
  actionRun: "0199a5f0-0000-7000-8000-0000000000b9",
};

const mocks = vi.hoisted(() => ({
  db: {
    workflowRun: { findMany: vi.fn(), findFirst: vi.fn() },
    sessionDetail: { findMany: vi.fn() },
    workflow: { findFirst: vi.fn() },
    workflowTrigger: { findFirst: vi.fn() },
    workflowActionRun: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  loadConnectionRuntime: vi.fn(),
  findTriggerDefinition: vi.fn(),
  resolveManual: vi.fn(),
  ingestEvents: vi.fn(),
  cancelRun: vi.fn(),
  listRunLoops: vi.fn(),
  listRunDocuments: vi.fn(),
  drainActionRuns: vi.fn(),
  waitUntil: vi.fn(),
  listToolCalls: vi.fn(),
  decideToolCall: vi.fn(),
}));

// The orchestrator's events are ingest-orchestrated.test.ts's.
vi.mock("@/lib/orchestrator/inbound", () => ({
  routeToOrchestrator: () => Promise.resolve([]),
}));
vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(mocks.db),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  loadConnectionRuntime: mocks.loadConnectionRuntime,
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("@/lib/integrations/registry", () => ({
  findTriggerDefinition: mocks.findTriggerDefinition,
}));
vi.mock("@/lib/workflows/engine/ingest", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/workflows/engine/ingest")>();
  return { ...original, ingestEvents: mocks.ingestEvents };
});
vi.mock("@/lib/workflows/engine/advance", () => ({
  CancelRunFailure: {
    NotFound: "not_found",
    AlreadyFinished: "already_finished",
    Busy: "busy",
  },
  cancelRun: mocks.cancelRun,
  advanceRun: vi.fn(),
}));
vi.mock("@/lib/workflows/engine/run-loops", () => ({
  listRunLoops: mocks.listRunLoops,
}));
vi.mock("@/lib/workflows/engine/step-documents", () => ({
  listRunDocuments: mocks.listRunDocuments,
}));
vi.mock("@/lib/workflows/engine/actions", () => ({
  drainActionRuns: mocks.drainActionRuns,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/app/integration-tools/integration-tool-call-service", () => ({
  integrationToolCallService: {
    listForRun: mocks.listToolCalls,
    decide: mocks.decideToolCall,
  },
}));

const SECRET = "jira-token-0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRunDocuments.mockResolvedValue([]);
  mocks.listToolCalls.mockResolvedValue([]);
  mocks.db.workflow.findFirst.mockResolvedValue({
    id: IDS.workflow,
    enabled: true,
  });
  mocks.db.workflowTrigger.findFirst.mockResolvedValue({
    id: IDS.trigger,
    type: "fake.issue_assigned",
    connectionId: "conn-1",
  });
  mocks.loadConnectionRuntime.mockResolvedValue({
    record: { name: "Jira", status: IntegrationConnectionStatus.Active },
    provider: {
      key: IntegrationProviderKey.Jira,
      source: { resolveManual: mocks.resolveManual },
    },
    runtime: { secrets: { apiToken: SECRET } },
  });
  mocks.findTriggerDefinition.mockReturnValue({
    manualRun: { label: "Issue key", placeholder: "PROJ-1" },
  });
  mocks.resolveManual.mockResolvedValue(buildEvent());
  mocks.ingestEvents.mockResolvedValue({
    outcome: IntegrationDeliveryOutcome.Accepted,
    runCount: 1,
    deliveryRowId: "row-1",
    decisions: [
      {
        triggerId: IDS.trigger,
        workflowId: IDS.workflow,
        decision: IngestDecision.Created,
        runId: IDS.run,
      },
    ],
    detail: null,
  });
  mocks.db.workflowRun.findFirst.mockResolvedValue(runRow());
  mocks.db.workflowActionRun.findMany.mockResolvedValue([]);
  mocks.listRunLoops.mockResolvedValue([]);
  mocks.db.sessionDetail.findMany.mockResolvedValue([]);
});

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.run,
    workflowId: IDS.workflow,
    triggerId: IDS.trigger,
    status: WorkflowRunStatus.Planning,
    sourceKey: `${IntegrationProviderKey.Jira}:PROJ-7`,
    source: {
      item: {
        provider: IntegrationProviderKey.Jira,
        externalId: "10007",
        key: "PROJ-7",
        url: "https://acme.atlassian.net/browse/PROJ-7",
        title: "Add CSV export",
        container: "PROJ",
      },
      occurredAt: "2026-10-01T10:00:00.000Z",
    },
    prUrl: null,
    repository: null,
    error: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    completedAt: null,
    workflow: { name: "Jira to PR" },
    trigger: { type: "fake.issue_assigned" },
    branchName: null,
    featureDocument: {
      id: "f-1",
      slug: "ISS-1",
      name: "PROJ-7: Add CSV export",
    },
    planDocument: null,
    ...overrides,
  };
}

describe("workflowRunService.list", () => {
  it("pages newest first with an opaque cursor", async () => {
    const rows = [
      runRow({ id: "0199a5f0-0000-7000-8000-000000000003" }),
      runRow({ id: "0199a5f0-0000-7000-8000-000000000002" }),
      runRow({ id: "0199a5f0-0000-7000-8000-000000000001" }),
    ];
    mocks.db.workflowRun.findMany.mockResolvedValueOnce(rows);

    const first = await workflowRunService.list(IDS.org, { limit: 2 });
    const page = first.ok ? first.value : expect.fail("page expected");

    expect(page.runs.map((run) => run.id)).toEqual([rows[0].id, rows[1].id]);
    expect(page.runs[0]).toMatchObject({
      workflowName: "Jira to PR",
      triggerType: "fake.issue_assigned",
      source: { key: "PROJ-7", provider: IntegrationProviderKey.Jira },
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(mocks.db.workflowRun.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: IDS.org },
      take: 3,
    });

    mocks.db.workflowRun.findMany.mockResolvedValueOnce([rows[2]]);
    const second = await workflowRunService.list(IDS.org, {
      limit: 2,
      cursor: page.nextCursor,
      status: WorkflowRunStatus.Planning,
    });

    expect(second.ok && second.value.nextCursor).toBeNull();
    expect(mocks.db.workflowRun.findMany.mock.calls[1][0].where).toEqual({
      organizationId: IDS.org,
      status: WorkflowRunStatus.Planning,
      OR: [
        { createdAt: { lt: rows[1].createdAt } },
        { createdAt: rows[1].createdAt, id: { lt: rows[1].id } },
      ],
    });
  });

  it("rejects a malformed cursor", async () => {
    const result = await workflowRunService.list(IDS.org, { cursor: "%%%" });

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
  });

  it("answers 404 for a workflow of another organization", async () => {
    mocks.db.workflow.findFirst.mockResolvedValue(null);

    const result = await workflowRunService.list(IDS.org, {
      workflowId: IDS.workflow,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
  });
});

describe("workflowRunService run pull requests", () => {
  function repository(fullName: string, pullRequest: number | null) {
    return {
      id: `repo-${fullName}`,
      connectionId: "conn-1",
      provider: "github",
      externalId: fullName,
      fullName,
      webUrl: `https://github.com/${fullName}`,
      cloneUrl: `https://github.com/${fullName}.git`,
      defaultBranch: "main",
      branch: pullRequest === null ? null : `feat/${fullName}`,
      baseBranch: "main",
      pullRequest:
        pullRequest === null
          ? null
          : {
              url: `https://github.com/${fullName}/pull/${pullRequest}`,
              number: pullRequest,
            },
    };
  }

  it("lists the pull request of every repository the run changed", async () => {
    mocks.db.workflowRun.findMany.mockResolvedValueOnce([
      runRow({
        prUrl: "https://github.com/acme/web/pull/12",
        branchName: "feat/acme/web",
        repository: [
          repository("acme/web", 12),
          repository("acme/docs", null),
          repository("acme/api", 4),
        ],
      }),
    ]);

    const result = await workflowRunService.list(IDS.org, {});
    const page = result.ok ? result.value : expect.fail("page expected");

    expect(page.runs[0]?.pullRequests).toEqual([
      {
        url: "https://github.com/acme/web/pull/12",
        number: 12,
        repository: "acme/web",
        branch: "feat/acme/web",
      },
      {
        url: "https://github.com/acme/api/pull/4",
        number: 4,
        repository: "acme/api",
        branch: "feat/acme/api",
      },
    ]);
  });

  it("falls back to the run's single pull request on older runs", async () => {
    mocks.db.workflowRun.findMany.mockResolvedValueOnce([
      runRow({
        prUrl: "https://github.com/acme/web/pull/3",
        branchName: "feat/proj-7",
        repository: null,
      }),
    ]);

    const result = await workflowRunService.list(IDS.org, {});
    const page = result.ok ? result.value : expect.fail("page expected");

    expect(page.runs[0]?.pullRequests).toEqual([
      {
        url: "https://github.com/acme/web/pull/3",
        number: null,
        repository: null,
        branch: "feat/proj-7",
      },
    ]);
  });
});

describe("workflowRunService.get", () => {
  it("returns documents, loops and action runs", async () => {
    mocks.db.workflowActionRun.findMany.mockResolvedValue([
      actionRunRow({ id: IDS.actionRun, externalRef: "c-1" }),
    ]);

    mocks.listRunDocuments.mockResolvedValue([
      {
        id: "prd-1",
        slug: "PRD-3",
        title: "PRD: Add CSV export",
        type: ProcessDocumentType.Prd,
        stepId: "prd",
      },
    ]);

    const detail = await workflowRunService.get(IDS.org, IDS.run);

    expect(detail).toMatchObject({
      id: IDS.run,
      feature: { id: "f-1", slug: "ISS-1", title: "PROJ-7: Add CSV export" },
      plan: null,
      documents: [
        {
          id: "prd-1",
          slug: "PRD-3",
          title: "PRD: Add CSV export",
          type: ProcessDocumentType.Prd,
          stepId: "prd",
        },
      ],
      loops: [],
      sessions: [],
      actionRuns: [
        {
          id: IDS.actionRun,
          stage: WorkflowActionStage.Post,
          event: WorkflowRunEvent.Started,
          cycle: 1,
        },
      ],
    });
    expect(mocks.db.workflowActionRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: IDS.run, organizationId: IDS.org },
        include: { action: { select: { position: true } } },
      })
    );
    expect(mocks.listRunDocuments).toHaveBeenCalledWith({
      id: IDS.run,
      organizationId: IDS.org,
      featureDocumentId: "f-1",
    });
  });

  it("orders action runs by cycle, stage (pre first), position, then creation", async () => {
    const early = new Date("2026-10-01T10:00:00.000Z");
    const late = new Date("2026-10-01T11:00:00.000Z");
    // Rows come back in creation order, like the query.
    mocks.db.workflowActionRun.findMany.mockResolvedValue([
      actionRunRow({ id: "post-1", createdAt: early, position: 0 }),
      actionRunRow({
        id: "pre-1b",
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        createdAt: early,
        position: 1,
      }),
      actionRunRow({
        id: "pre-1a",
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        createdAt: early,
        position: 0,
      }),
      actionRunRow({
        id: "pre-1-removed",
        actionId: null,
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        createdAt: early,
        position: null,
      }),
      actionRunRow({
        id: "pre-2",
        stage: WorkflowActionStage.Pre,
        event: WorkflowRunEvent.Triggered,
        cycle: 2,
        createdAt: late,
        position: 0,
      }),
      actionRunRow({
        id: "post-1-late",
        event: WorkflowRunEvent.Failed,
        createdAt: late,
        position: 0,
      }),
    ]);

    const detail = await workflowRunService.get(IDS.org, IDS.run);

    expect(detail?.actionRuns.map((run) => run.id)).toEqual([
      "pre-1a",
      "pre-1b",
      "pre-1-removed",
      "post-1",
      "post-1-late",
      "pre-2",
    ]);
  });

  it("returns null for a malformed id without querying", async () => {
    await expect(workflowRunService.get(IDS.org, "x")).resolves.toBeNull();
    expect(mocks.db.workflowRun.findFirst).not.toHaveBeenCalled();
  });
});

describe("workflowRunService.startManualRun", () => {
  const start = () =>
    workflowRunService.startManualRun(IDS.org, IDS.workflow, {
      triggerId: IDS.trigger,
      input: "PROJ-7",
    });

  it("resolves the item and ingests it as a manual delivery for that trigger", async () => {
    const result = await start();

    expect(result).toMatchObject({ ok: true, value: { id: IDS.run } });
    expect(mocks.resolveManual).toHaveBeenCalledWith(
      expect.anything(),
      "PROJ-7",
      "fake.issue_assigned"
    );
    expect(mocks.ingestEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        source: IntegrationDeliverySource.Manual,
        manualTriggerId: IDS.trigger,
        deliveryId: expect.stringMatching(MANUAL_DELIVERY_RE),
        events: [
          expect.objectContaining({ triggerType: "fake.issue_assigned" }),
        ],
      })
    );
  });

  it("refuses a trigger of another workflow", async () => {
    mocks.db.workflowTrigger.findFirst.mockResolvedValue(null);

    await expect(start()).resolves.toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
    expect(mocks.ingestEvents).not.toHaveBeenCalled();
  });

  it("refuses a disabled workflow", async () => {
    mocks.db.workflow.findFirst.mockResolvedValue({
      id: IDS.workflow,
      enabled: false,
    });

    await expect(start()).resolves.toMatchObject({
      ok: false,
      error: { status: Status.BadRequest },
    });
  });

  it("answers 400 with the provider message, without secrets", async () => {
    mocks.resolveManual.mockRejectedValue(
      new Error(`Issue PROJ-7 not found (token ${SECRET})`)
    );

    const result = await start();

    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("Issue PROJ-7 not found");
    expect(message).not.toContain(SECRET);
  });

  it("answers 409 when the item already has an active run", async () => {
    mocks.ingestEvents.mockResolvedValue({
      outcome: IntegrationDeliveryOutcome.Ignored,
      runCount: 0,
      deliveryRowId: "row-1",
      decisions: [
        {
          triggerId: IDS.trigger,
          workflowId: IDS.workflow,
          decision: IngestDecision.Active,
          runId: IDS.run,
        },
      ],
      detail: "Run already active",
    });

    await expect(start()).resolves.toMatchObject({
      ok: false,
      error: { status: Status.Conflict },
    });
  });
});

describe("workflowRunService.retryActionRun", () => {
  it("puts a failed action run back in the outbox and drains it", async () => {
    mocks.db.workflowActionRun.updateMany.mockResolvedValue({ count: 1 });

    const result = await workflowRunService.retryActionRun(
      IDS.org,
      IDS.run,
      IDS.actionRun
    );

    expect(result.ok).toBe(true);
    expect(mocks.db.workflowActionRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: IDS.actionRun,
        runId: IDS.run,
        organizationId: IDS.org,
        stage: WorkflowActionStage.Post,
        status: {
          in: [WorkflowActionRunStatus.Failed, WorkflowActionRunStatus.Skipped],
        },
      },
      data: expect.objectContaining({
        status: WorkflowActionRunStatus.Pending,
        attempts: 0,
      }),
    });
    expect(mocks.drainActionRuns).toHaveBeenCalledWith({ runId: IDS.run });
  });

  it("answers 409 for an action run that is not failed or skipped", async () => {
    mocks.db.workflowActionRun.updateMany.mockResolvedValue({ count: 0 });
    mocks.db.workflowActionRun.findFirst.mockResolvedValue({
      id: IDS.actionRun,
      stage: WorkflowActionStage.Post,
    });

    await expect(
      workflowRunService.retryActionRun(IDS.org, IDS.run, IDS.actionRun)
    ).resolves.toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        message: "Only failed or skipped action runs can be retried.",
      },
    });
  });

  it("answers 409 for a pre action run (pre actions belong to the run's start)", async () => {
    mocks.db.workflowActionRun.updateMany.mockResolvedValue({ count: 0 });
    mocks.db.workflowActionRun.findFirst.mockResolvedValue({
      id: IDS.actionRun,
      stage: WorkflowActionStage.Pre,
    });

    const result = await workflowRunService.retryActionRun(
      IDS.org,
      IDS.run,
      IDS.actionRun
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.Conflict },
    });
    expect(result.ok ? "" : result.error.message).toContain("Pre actions");
    expect(mocks.drainActionRuns).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown action run", async () => {
    mocks.db.workflowActionRun.updateMany.mockResolvedValue({ count: 0 });
    mocks.db.workflowActionRun.findFirst.mockResolvedValue(null);

    await expect(
      workflowRunService.retryActionRun(IDS.org, IDS.run, IDS.actionRun)
    ).resolves.toMatchObject({ ok: false, error: { status: Status.NotFound } });
  });
});

describe("workflowRunService.cancel", () => {
  it.each([
    [CancelRunFailure.NotFound, Status.NotFound],
    [CancelRunFailure.AlreadyFinished, Status.Conflict],
    [CancelRunFailure.Busy, Status.Conflict],
  ])("maps %s to HTTP %s", async (failure, status) => {
    mocks.cancelRun.mockResolvedValue(Result.err(failure));

    await expect(
      workflowRunService.cancel(IDS.org, IDS.run)
    ).resolves.toMatchObject({ ok: false, error: { status } });
  });

  it("returns the run detail after cancelling", async () => {
    mocks.cancelRun.mockResolvedValue(Result.ok(null));
    mocks.db.workflowRun.findFirst.mockResolvedValue(
      runRow({ status: WorkflowRunStatus.Cancelled })
    );

    const result = await workflowRunService.cancel(IDS.org, IDS.run);

    expect(result).toMatchObject({
      ok: true,
      value: { status: WorkflowRunStatus.Cancelled },
    });
  });
});

describe("workflowRunService tool calls", () => {
  const CALL_ID = "0199a5f0-0000-7000-8000-0000000000c7";
  const call = {
    id: CALL_ID,
    tool: "microsoft_teams_post_message",
    operationType: "microsoft_teams.post_message",
    connectionKey: "teams-release",
    input: { message: "Shipped." },
    status: IntegrationToolCallStatus.PendingApproval,
    externalRef: null,
    error: null,
    actionRunId: IDS.actionRun,
    stepId: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date("2026-10-13T10:00:00.000Z"),
  };

  beforeEach(() => {
    mocks.db.workflowRun.findFirst.mockResolvedValue(runRow());
    mocks.listToolCalls.mockResolvedValue([call]);
  });

  it("lists the run's tool calls on its detail", async () => {
    const detail = await workflowRunService.get(IDS.org, IDS.run);

    expect(detail?.toolCalls).toEqual([call]);
    expect(mocks.listToolCalls).toHaveBeenCalledWith(IDS.org, IDS.run);
  });

  it("decides a call and returns the run detail", async () => {
    mocks.decideToolCall.mockResolvedValue(Result.ok(undefined));

    const result = await workflowRunService.decideToolCall({
      organizationId: IDS.org,
      runId: IDS.run,
      callId: CALL_ID,
      decision: ToolCallDecision.Approve,
      userId: "user-1",
    });

    expect(result).toMatchObject({ ok: true, value: { id: IDS.run } });
    expect(mocks.decideToolCall).toHaveBeenCalledWith({
      organizationId: IDS.org,
      runId: IDS.run,
      callId: CALL_ID,
      decision: ToolCallDecision.Approve,
      userId: "user-1",
    });
  });

  it("answers a decided call with its conflict", async () => {
    mocks.decideToolCall.mockResolvedValue(
      Result.err({ status: Status.Conflict, message: "decided" })
    );

    const result = await workflowRunService.decideToolCall({
      organizationId: IDS.org,
      runId: IDS.run,
      callId: CALL_ID,
      decision: ToolCallDecision.Reject,
      userId: "user-1",
    });

    expect(result).toEqual({
      ok: false,
      error: { status: Status.Conflict, message: "decided" },
    });
  });

  it("does not look up a call id that is not a uuid", async () => {
    const result = await workflowRunService.decideToolCall({
      organizationId: IDS.org,
      runId: IDS.run,
      callId: "nope",
      decision: ToolCallDecision.Approve,
      userId: "user-1",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { status: Status.NotFound },
    });
    expect(mocks.decideToolCall).not.toHaveBeenCalled();
  });
});

const MANUAL_DELIVERY_RE = /^manual:/;

function actionRunRow(
  overrides: Record<string, unknown> & { position?: number | null } = {}
) {
  const { position = 0, ...row } = overrides;
  return {
    id: IDS.actionRun,
    actionId: "a-1",
    actionType: "fake.post",
    stage: WorkflowActionStage.Post,
    event: WorkflowRunEvent.Started,
    cycle: 1,
    status: WorkflowActionRunStatus.Succeeded,
    attempts: 1,
    lastError: null,
    externalRef: null,
    completedAt: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    action: position === null ? null : { position },
    ...row,
  };
}
