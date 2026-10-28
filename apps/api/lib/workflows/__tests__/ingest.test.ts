import {
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import {
  WorkflowRunEvent,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvent,
  buildLoadedConnection,
  CONNECTION_ID,
  createIngestDbFake,
  type IngestDbFake,
  ORG_ID,
  PRISMA_DB_NULL,
  PROJECT_CONNECTION_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
  TRIGGER_ID,
  TRIGGER_TYPE,
  WORKFLOW_ID,
} from "@/lib/workflows/__tests__/support/ingest-db.test-fake";
import {
  DELIVERY_PAYLOAD_MAX_CHARS,
  IngestDecision,
  type IngestEventsInput,
  ingestEvents,
  toDeliveryPayload,
} from "@/lib/workflows/engine/ingest";

const mocks = vi.hoisted(() => ({
  fake: null as IngestDbFake | null,
  advanceRun: vi.fn(() => Promise.resolve("advanced")),
  hasEnabledPreActions: vi.fn(),
  enqueueRunEvents: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/ingest-db.test-fake"
  );
  const withDb = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  withDb.tx = (fn: (db: unknown) => unknown) => fn(mocks.fake?.db);
  return { withDb, Prisma: { DbNull: support.PRISMA_DB_NULL } };
});
vi.mock("@/lib/integrations/registry", async () => {
  const support = await import(
    "@/lib/workflows/__tests__/support/ingest-db.test-fake"
  );
  return {
    findTriggerDefinition: (_provider: string, type: string) =>
      type === support.TRIGGER_TYPE ? support.fakeTriggerDefinition : null,
  };
});
vi.mock("@/lib/workflows/engine/advance", () => ({
  advanceRun: mocks.advanceRun,
}));
vi.mock("@/lib/workflows/engine/actions", () => ({
  hasEnabledPreActions: mocks.hasEnabledPreActions,
  enqueueRunEvents: mocks.enqueueRunEvents,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: mocks.waitUntil }));
// ingest-orchestrated.test.ts covers the orchestrator's events.
vi.mock("@/lib/orchestrator/inbound", () => ({
  routeToOrchestrator: () => Promise.resolve([]),
}));

let fake: IngestDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createIngestDbFake();
  mocks.fake = fake;
  fake.addWorkflow();
  fake.addTrigger();
  fake.addScope("PROJ");
  mocks.hasEnabledPreActions.mockResolvedValue(false);
  mocks.enqueueRunEvents.mockResolvedValue(1);
});

function input(overrides: Partial<IngestEventsInput> = {}): IngestEventsInput {
  return {
    connection: buildLoadedConnection(),
    source: IntegrationDeliverySource.Webhook,
    deliveryId: "delivery-1",
    eventType: "jira:issue_updated",
    events: [buildEvent()],
    payload: { webhookEvent: "jira:issue_updated" },
    ...overrides,
  };
}

describe("ingestEvents", () => {
  it("creates a run for a matching trigger and advances it", async () => {
    const result = await ingestEvents(input());

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Accepted);
    expect(result.runCount).toBe(1);
    expect(result.decisions).toEqual([
      {
        triggerId: TRIGGER_ID,
        workflowId: WORKFLOW_ID,
        decision: IngestDecision.Created,
        runId: "run-1",
      },
    ]);
    expect(fake.runs[0]).toMatchObject({
      status: WorkflowRunStatus.Received,
      dedupKey: "PROJ-7:assignee:100",
      sourceKey: `${IntegrationProviderKey.Jira}:PROJ-7`,
      triggerId: TRIGGER_ID,
      connectionId: CONNECTION_ID,
      deliveryId: result.deliveryRowId,
      runAsUserId: RUN_AS_USER_ID,
      agentConfig: { computeTargetId: "ct-1", mode: WorkflowAgentMode.Plan },
      source: {
        item: { key: "PROJ-7" },
        actor: { id: "ba-1" },
        attributes: { projectKey: "PROJ" },
        extras: {},
        occurredAt: "2026-10-01T10:00:00.000Z",
      },
    });
    expect(fake.deliveries[0]).toMatchObject({
      outcome: IntegrationDeliveryOutcome.Accepted,
      runCount: 1,
      source: IntegrationDeliverySource.Webhook,
      payload: { webhookEvent: "jira:issue_updated" },
    });
    expect(fake.connectionUpdates[0]).toHaveProperty("lastDeliveryAt");
    expect(fake.workflows.get(WORKFLOW_ID)).toHaveProperty("lastRunAt");
    expect(fake.db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.advanceRun).toHaveBeenCalledWith("run-1");
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("reports a repeated delivery id as duplicate and does nothing", async () => {
    await ingestEvents(input());
    mocks.advanceRun.mockClear();

    const second = await ingestEvents(input());

    expect(second.outcome).toBe(IntegrationDeliveryOutcome.Duplicate);
    expect(second.deliveryRowId).toBeNull();
    expect(fake.runs).toHaveLength(1);
    expect(fake.deliveries).toHaveLength(1);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("ignores events the trigger filter rejects", async () => {
    const result = await ingestEvents(
      input({ events: [buildEvent({ attributes: { projectKey: "OTHER" } })] })
    );

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(result.detail).toBe("No enabled trigger matched");
    expect(fake.runs).toHaveLength(0);
    expect(fake.deliveries[0].outcome).toBe(IntegrationDeliveryOutcome.Ignored);
  });

  it("skips triggers whose stored config no longer parses", async () => {
    fake.triggers[0].config = { projectKeys: [] };

    const result = await ingestEvents(input());

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(fake.runs).toHaveLength(0);
  });

  it("does not match disabled workflows or triggers of other types", async () => {
    fake.workflows.set(WORKFLOW_ID, {
      ...(fake.workflows.get(WORKFLOW_ID) ?? { id: WORKFLOW_ID }),
      enabled: false,
    });

    const result = await ingestEvents(input());

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(fake.runs).toHaveLength(0);
  });

  it("does nothing for an occurrence the workflow already has a run for", async () => {
    fake.addRun({
      status: WorkflowRunStatus.Succeeded,
      dedupKey: "PROJ-7:assignee:100",
    });

    const result = await ingestEvents(input());

    expect(result.decisions[0].decision).toBe(IngestDecision.Duplicate);
    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(result.detail).toBe("Occurrence already handled");
    expect(fake.runs).toHaveLength(1);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("leaves an active run for the same item alone", async () => {
    fake.addRun({ status: WorkflowRunStatus.Planning });

    const result = await ingestEvents(input());

    expect(result.decisions[0].decision).toBe(IngestDecision.Active);
    expect(result.detail).toBe("Run already active");
    expect(fake.runs).toHaveLength(1);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("keeps the event extras (not the filter attributes) as the run's source extras", async () => {
    await ingestEvents(
      input({
        events: [
          buildEvent({
            extras: { callbackUrl: "https://cb.test", metadata: { a: 1 } },
          }),
        ],
      })
    );

    expect(fake.runs[0].source).toMatchObject({
      attributes: { projectKey: "PROJ" },
      extras: { callbackUrl: "https://cb.test", metadata: { a: 1 } },
    });
  });

  it("resumes a needs_input run for the same item in the next cycle", async () => {
    fake.addRun({
      status: WorkflowRunStatus.NeedsInput,
      error: { code: "x" },
      stepAttempts: 2,
      nextStepAt: new Date("2026-10-01T00:30:00.000Z"),
    });

    const result = await ingestEvents(
      input({ events: [buildEvent({ dedupKey: "PROJ-7:assignee:200" })] })
    );

    expect(result.decisions[0]).toMatchObject({
      decision: IngestDecision.Resumed,
      runId: "run-1",
    });
    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Accepted);
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]).toMatchObject({
      status: WorkflowRunStatus.Ingesting,
      cycle: 2,
      occurrenceKeys: ["PROJ-7:assignee:200"],
      error: PRISMA_DB_NULL,
      source: { item: { key: "PROJ-7" } },
      // A status change starts the new step without retry state.
      stepAttempts: 0,
      nextStepAt: null,
    });
    expect(mocks.enqueueRunEvents).not.toHaveBeenCalled();
    expect(mocks.advanceRun).toHaveBeenCalledWith("run-1");
  });

  it("resumes into pre_actions with this cycle's run.triggered rows when the workflow has pre actions", async () => {
    mocks.hasEnabledPreActions.mockResolvedValue(true);
    fake.addRun({ status: WorkflowRunStatus.NeedsInput, cycle: 2 });

    const result = await ingestEvents(
      input({ events: [buildEvent({ dedupKey: "PROJ-7:assignee:300" })] })
    );

    expect(result.decisions[0].decision).toBe(IngestDecision.Resumed);
    expect(fake.runs[0]).toMatchObject({
      status: WorkflowRunStatus.PreActions,
      cycle: 3,
      occurrenceKeys: ["PROJ-7:assignee:300"],
    });
    expect(mocks.hasEnabledPreActions).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(mocks.enqueueRunEvents).toHaveBeenCalledWith(
      {
        id: "run-1",
        organizationId: ORG_ID,
        workflowId: WORKFLOW_ID,
        cycle: 3,
      },
      [WorkflowRunEvent.Triggered]
    );
    expect(mocks.advanceRun).toHaveBeenCalledWith("run-1");
  });

  it("ignores a replay of the occurrence that resumed a run, even after the run finished", async () => {
    fake.addRun({ status: WorkflowRunStatus.NeedsInput });
    await ingestEvents(
      input({ events: [buildEvent({ dedupKey: "PROJ-7:assignee:200" })] })
    );
    fake.runs[0].status = WorkflowRunStatus.Succeeded;
    mocks.advanceRun.mockClear();

    // Same occurrence, delivered again (e.g. by the poller instead of the webhook).
    const replay = await ingestEvents(
      input({
        deliveryId: "poll:PROJ-7:assignee:200",
        events: [buildEvent({ dedupKey: "PROJ-7:assignee:200" })],
      })
    );

    expect(replay.decisions[0]).toMatchObject({
      decision: IngestDecision.Duplicate,
      runId: "run-1",
    });
    expect(replay.detail).toBe("Occurrence already handled");
    expect(fake.runs).toHaveLength(1);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("runs a manual trigger without its filter and with a unique dedupKey", async () => {
    const result = await ingestEvents(
      input({
        source: IntegrationDeliverySource.Manual,
        deliveryId: "manual:1",
        manualTriggerId: TRIGGER_ID,
        events: [buildEvent({ attributes: { projectKey: "OTHER" } })],
      })
    );

    expect(result.decisions[0].decision).toBe(IngestDecision.Created);
    expect(fake.runs[0].dedupKey).toBe(
      `PROJ-7:assignee:100:manual:${result.deliveryRowId}`
    );
    expect(fake.deliveries[0].source).toBe(IntegrationDeliverySource.Manual);
  });

  it("records the provider's reason when a delivery has no events", async () => {
    const result = await ingestEvents(
      input({ events: [], ignoredReason: "Event caused by the bot" })
    );

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(fake.deliveries[0].detail).toBe("Event caused by the bot");
    expect(fake.db.workflowTrigger.findMany).not.toHaveBeenCalled();
  });

  it("treats a concurrent insert of the same occurrence as existing", async () => {
    fake.failNextCreate(
      Object.assign(new Error("Unique constraint"), { code: "P2002" }),
      { status: WorkflowRunStatus.Received }
    );

    const result = await ingestEvents(input());

    expect(result.decisions[0]).toMatchObject({
      decision: IngestDecision.Duplicate,
      runId: "run-winner",
    });
    expect(mocks.advanceRun).not.toHaveBeenCalled();
  });

  it("forgets the delivery when processing fails so a retry is processed", async () => {
    fake.failNextCreate(new Error("connection reset"));

    await expect(ingestEvents(input())).rejects.toThrow("connection reset");

    expect(fake.deliveries).toHaveLength(0);
  });

  it("only considers triggers of the event's type", async () => {
    fake.addTrigger({ id: "other-trigger", type: `${TRIGGER_TYPE}_other` });

    const result = await ingestEvents(input());

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].triggerId).toBe(TRIGGER_ID);
  });
});

describe("toDeliveryPayload", () => {
  it("stores a JSON body as parsed JSON", () => {
    expect(toDeliveryPayload('{"a":1,"b":[true]}')).toEqual({
      a: 1,
      b: [true],
    });
  });

  it("keeps a non-JSON body as text", () => {
    expect(toDeliveryPayload("hello=world")).toBe("hello=world");
  });

  it("truncates large bodies to a preview", () => {
    const payload = toDeliveryPayload(
      JSON.stringify({ text: "z".repeat(DELIVERY_PAYLOAD_MAX_CHARS) })
    );
    expect(payload).toMatchObject({ truncated: true });
    expect(JSON.stringify(payload).length).toBeLessThan(
      DELIVERY_PAYLOAD_MAX_CHARS + 100
    );
  });

  it("serializes events with dates", () => {
    expect(toDeliveryPayload(buildEvent())).toMatchObject({
      dedupKey: "PROJ-7:assignee:100",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
  });

  it("returns null without a body", () => {
    expect(toDeliveryPayload(undefined)).toBeNull();
  });
});

describe("ingestEvents routing to project connections", () => {
  it("records the trigger's project and project connection on the run", async () => {
    await ingestEvents(input());

    expect(fake.runs[0]).toMatchObject({
      projectId: PROJECT_ID,
      projectConnectionId: PROJECT_CONNECTION_ID,
    });
  });

  it("ignores an item whose project no project connection claims", async () => {
    const result = await ingestEvents(
      input({
        events: [
          buildEvent({ item: { ...buildEvent().item, container: "OTHER" } }),
        ],
      })
    );

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(result.detail).toContain(
      "No project connection of this connection takes the item"
    );
    expect(fake.runs).toHaveLength(0);
  });

  it("starts runs only for triggers of the project connection that claims the item", async () => {
    fake.addTrigger({ id: OTHER_TRIGGER_ID, projectConnectionId: OTHER_PC_ID });

    const result = await ingestEvents(input());

    expect(result.decisions.map((decision) => decision.triggerId)).toEqual([
      TRIGGER_ID,
    ]);
  });

  it("routes an item the project's connections share to the one it arrived on", async () => {
    fake.addScope("PROJ", OTHER_PC_ID, OTHER_CONNECTION_ID);
    fake.addTrigger({
      id: OTHER_TRIGGER_ID,
      connectionId: OTHER_CONNECTION_ID,
      projectConnectionId: OTHER_PC_ID,
    });

    const devBot = await ingestEvents(input());
    const qcBot = await ingestEvents(
      input({ connection: buildLoadedConnection(OTHER_CONNECTION_ID) })
    );

    expect(devBot.decisions.map((decision) => decision.triggerId)).toEqual([
      TRIGGER_ID,
    ]);
    expect(qcBot.decisions.map((decision) => decision.triggerId)).toEqual([
      OTHER_TRIGGER_ID,
    ]);
  });

  it("ignores an item claimed only through another connection to the site", async () => {
    fake.addScope("FOREIGN", OTHER_PC_ID, OTHER_CONNECTION_ID);
    const foreignItem = buildEvent({
      item: { ...buildEvent().item, container: "FOREIGN" },
    });

    const result = await ingestEvents(input({ events: [foreignItem] }));

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(fake.runs).toHaveLength(0);
  });
});

const OTHER_TRIGGER_ID = "0199a5f0-0000-7000-8000-0000000000e9";
const OTHER_PC_ID = "0199a5f0-0000-7000-8000-0000000000b9";
const OTHER_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000c9";

describe("replies to a run's comments", () => {
  it("resumes the waiting run that posted the replied comment, and only that run", async () => {
    const dev = fake.addRun({ status: WorkflowRunStatus.NeedsInput });
    const qc = fake.addRun({
      status: WorkflowRunStatus.NeedsInput,
      workflowId: QC_WORKFLOW_ID,
    });
    fake.addRunComment(dev.id, DEV_QUESTION_ID);
    fake.addRunComment(qc.id, QC_QUESTION_ID, "action");

    const result = await ingestEvents(replyInput(QC_QUESTION_ID));

    expect(result.decisions).toEqual([
      {
        triggerId: null,
        workflowId: QC_WORKFLOW_ID,
        decision: IngestDecision.Resumed,
        runId: qc.id,
      },
    ]);
    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Accepted);
    expect(qc).toMatchObject({
      status: WorkflowRunStatus.Ingesting,
      cycle: 2,
      occurrenceKeys: [REPLY_DEDUP_KEY],
    });
    expect(dev.status).toBe(WorkflowRunStatus.NeedsInput);
    expect(mocks.advanceRun).toHaveBeenCalledWith(qc.id);
  });

  it("ignores a reply to a comment no waiting run posted", async () => {
    const dev = fake.addRun({ status: WorkflowRunStatus.NeedsInput });
    fake.addRunComment(dev.id, DEV_QUESTION_ID);

    const result = await ingestEvents(replyInput("99999"));

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(dev.status).toBe(WorkflowRunStatus.NeedsInput);
  });

  it("resumes nothing when the replied run no longer waits for answers", async () => {
    const dev = fake.addRun({ status: WorkflowRunStatus.Running });
    fake.addRunComment(dev.id, DEV_QUESTION_ID);

    const result = await ingestEvents(replyInput(DEV_QUESTION_ID));

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
    expect(dev).toMatchObject({ status: WorkflowRunStatus.Running, cycle: 1 });
  });

  it("does not resume the run again on a redelivery of the reply", async () => {
    const dev = fake.addRun({
      status: WorkflowRunStatus.NeedsInput,
      occurrenceKeys: [REPLY_DEDUP_KEY],
    });
    fake.addRunComment(dev.id, DEV_QUESTION_ID);

    const result = await ingestEvents(
      replyInput(DEV_QUESTION_ID, "delivery-2")
    );

    expect(result.decisions[0]?.decision).toBe(IngestDecision.Duplicate);
    expect(dev.status).toBe(WorkflowRunStatus.NeedsInput);
  });
});

const QC_WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f2";
const DEV_QUESTION_ID = "10087";
const QC_QUESTION_ID = "10095";
const REPLY_DEDUP_KEY = "PROJ-7:reply:10100";
const REPLY_TRIGGER_TYPE = "fake.comment_reply";

/** A reply event (no trigger takes its type) on a provider with answerReply. */
function replyInput(
  repliedTo: string,
  deliveryId = "delivery-reply"
): IngestEventsInput {
  const connection = buildLoadedConnection();
  connection.provider.answerReply = (event) =>
    event.triggerType === REPLY_TRIGGER_TYPE
      ? String(event.attributes.repliedTo)
      : null;
  return input({
    connection,
    deliveryId,
    eventType: "comment_created",
    events: [
      buildEvent({
        triggerType: REPLY_TRIGGER_TYPE,
        dedupKey: REPLY_DEDUP_KEY,
        attributes: { projectKey: "PROJ", repliedTo },
      }),
    ],
  });
}
