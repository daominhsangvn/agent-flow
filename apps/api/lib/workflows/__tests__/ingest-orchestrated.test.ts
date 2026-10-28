import {
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvent,
  buildLoadedConnection,
  createIngestDbFake,
  type IngestDbFake,
  PROJECT_CONNECTION_ID,
  PROJECT_ID,
  WORKFLOW_ID,
} from "@/lib/workflows/__tests__/support/ingest-db.test-fake";
import {
  type IngestEventsInput,
  ingestEvents,
} from "@/lib/workflows/engine/ingest";

/**
 * A workflow handed to the orchestrator (`agent.mode: orchestrated`) starts no
 * run: its trigger's events go to the project's orchestrator instead
 * (docs/orchestrator.md).
 */

const mocks = vi.hoisted(() => ({
  fake: null as IngestDbFake | null,
  advanceRun: vi.fn(() => Promise.resolve("advanced")),
  routeToOrchestrator: vi.fn(),
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
  hasEnabledPreActions: () => Promise.resolve(false),
  enqueueRunEvents: () => Promise.resolve(1),
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/orchestrator/inbound", () => ({
  routeToOrchestrator: mocks.routeToOrchestrator,
}));

let fake: IngestDbFake;

beforeEach(() => {
  vi.clearAllMocks();
  fake = createIngestDbFake();
  mocks.fake = fake;
  fake.addTrigger();
  fake.addScope("PROJ");
  mocks.routeToOrchestrator.mockResolvedValue([]);
});

function input(): IngestEventsInput {
  return {
    connection: buildLoadedConnection(),
    source: IntegrationDeliverySource.Webhook,
    deliveryId: "delivery-1",
    eventType: "jira:issue_updated",
    events: [buildEvent()],
    payload: null,
  };
}

describe("ingestEvents — orchestrated workflows", () => {
  it("starts no run for an orchestrated workflow's trigger: the orchestrator takes it", async () => {
    fake.addWorkflow({
      agentConfig: {
        computeTargetId: "ct-1",
        mode: WorkflowAgentMode.Orchestrated,
      },
    });
    mocks.routeToOrchestrator.mockResolvedValue([
      {
        conversationId: "conversation-1",
        workflowId: WORKFLOW_ID,
        created: true,
      },
    ]);

    const result = await ingestEvents(input());

    expect(result.runCount).toBe(0);
    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Accepted);
    expect(result.detail).toBe("1 message to the orchestrator");
    expect(fake.runs).toEqual([]);
    expect(mocks.advanceRun).not.toHaveBeenCalled();
    expect(mocks.routeToOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConnectionId: PROJECT_CONNECTION_ID,
        workflows: [{ workflowId: WORKFLOW_ID, projectId: PROJECT_ID }],
      })
    );
  });

  it("offers every event to the orchestrator, with no workflow when none matched (a reply it may own)", async () => {
    fake.addWorkflow();

    await ingestEvents(input());

    expect(mocks.routeToOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ workflows: [] })
    );
  });

  it("reports a message the orchestrator already had as nothing new", async () => {
    fake.addWorkflow({
      agentConfig: {
        computeTargetId: "ct-1",
        mode: WorkflowAgentMode.Orchestrated,
      },
    });
    mocks.routeToOrchestrator.mockResolvedValue([
      {
        conversationId: "conversation-1",
        workflowId: WORKFLOW_ID,
        created: false,
      },
    ]);

    const result = await ingestEvents(input());

    expect(result.outcome).toBe(IntegrationDeliveryOutcome.Ignored);
  });

  it("still starts a run for the other modes", async () => {
    fake.addWorkflow();

    const result = await ingestEvents(input());

    expect(result.runCount).toBe(1);
  });
});
