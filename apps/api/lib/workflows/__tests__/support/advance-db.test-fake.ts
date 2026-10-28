import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  type WorkflowAgentConfig,
  workflowPrdRuleSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { vi } from "vitest";
import {
  createActionRunsDbFake,
  type FakeRow,
  matchesWhere,
} from "@/lib/workflows/__tests__/support/action-runs-db.test-fake";

/**
 * In-memory stand-in for the delegates lib/workflows/engine/advance.ts and
 * phases.ts use directly: one workflow_runs row (lease acquire/release with
 * the step-retry filter, renewal and status-guarded transitions), the
 * project and run-as user lookups, the loop error events the revival check
 * reads, and the workflow_actions / workflow_action_runs rows the
 * pre_actions step reads and writes (see action-runs-db.test-fake.ts).
 */

export const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
export const RUN_ID = "0199a5f0-0000-7000-8000-0000000000b1";
export const WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f1";
export const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
export const RUN_AS_USER_ID = "0199a5f0-0000-7000-8000-0000000000a1";
export const COMPUTE_TARGET_ID = "0199a5f0-0000-7000-8000-0000000000c1";
export const PLAN_DOCUMENT_ID = "0199a5f0-0000-7000-8000-0000000000d9";
export const FEATURE_DOCUMENT_ID = "0199a5f0-0000-7000-8000-0000000000d8";
export const CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000cc";
export const PRISMA_DB_NULL = "__db_null__";

export const AGENT_CONFIG: WorkflowAgentConfig = {
  mode: WorkflowAgentMode.PlanAndExecute,
  stopOnOpenQuestions: true,
  computeTargetId: COMPUTE_TARGET_ID,
  runners: [],
  repository: null,
  prd: workflowPrdRuleSchema.parse({}),
  instructions: "",
  titleTemplate: "{{source.key}}: {{source.title}}",
  process: null,
};

export type FakeRun = Record<string, unknown> & {
  status: string;
  leaseUntil: Date | null;
};

type Where = Record<string, unknown> & {
  status?: string | { notIn?: string[]; in?: string[] };
  leaseUntil?: Date;
  OR?: Array<{ leaseUntil: null | { lt: Date } }>;
  AND?: Array<{ OR: Array<{ nextStepAt: null | { lte: Date } }> }>;
};

/** A loop_events row as the revival check reads it. */
export type FakeLoopEvent = {
  loopId: string;
  type: string;
  data: unknown;
  createdAt: Date;
};

export function createAdvanceDbFake() {
  const state = {
    run: null as FakeRun | null,
    projectExists: true,
    runAsUserActive: true,
    loopEvents: [] as FakeLoopEvent[],
    /** The project's current process version; null: the built-in flow. */
    projectProcess: null as { version: number; definition: unknown } | null,
    toolSessions: [] as { loopId: string; issuedAt: Date | null }[],
    /** Integration tool calls of the run (the comments it posted, by ref). */
    toolCalls: [] as FakeRow[],
  };
  const actionDb = createActionRunsDbFake();

  const db = {
    ...actionDb.db,
    workflowRun: {
      updateMany: vi.fn(
        (args: { where: Where; data: Record<string, unknown> }) => {
          const run = state.run;
          if (!(run && matchesRun(run, args.where))) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(run, args.data);
          return Promise.resolve({ count: 1 });
        }
      ),
      findUnique: vi.fn(() =>
        Promise.resolve(state.run ? { ...state.run } : null)
      ),
      findFirst: vi.fn(() =>
        Promise.resolve(state.run ? { status: state.run.status } : null)
      ),
    },
    project: {
      findFirst: vi.fn(() =>
        Promise.resolve(state.projectExists ? { id: PROJECT_ID } : null)
      ),
    },
    projectProcessVersion: {
      findFirst: vi.fn(() => Promise.resolve(state.projectProcess)),
    },
    user: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          state.runAsUserActive
            ? { id: RUN_AS_USER_ID, clerkId: "auth-user-1" }
            : null
        )
      ),
    },
    loopEvent: {
      findFirst: vi.fn((args: { where: { loopId: string; type: string } }) => {
        const latest = state.loopEvents
          .filter(
            (event) =>
              event.loopId === args.where.loopId &&
              event.type === args.where.type
          )
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime()
          )[0];
        return Promise.resolve(latest ? { data: latest.data } : null);
      }),
    },
    integrationToolCall: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          state.toolCalls.filter((call) => matchesWhere(call, args.where))
        )
      ),
    },
    // Integration tool sessions of STEP loops: none unless a test adds one.
    integrationToolSession: {
      findUnique: vi.fn((args: { where: { loopId: string } }) =>
        Promise.resolve(
          state.toolSessions.find(
            (session) => session.loopId === args.where.loopId
          ) ?? null
        )
      ),
    },
  };

  return {
    db,
    state,
    actionDb,
    setRun(overrides: Partial<FakeRun> & { status: string }) {
      state.run = {
        id: RUN_ID,
        organizationId: ORG_ID,
        workflowId: WORKFLOW_ID,
        cycle: 1,
        source: {
          item: {
            provider: IntegrationProviderKey.Jira,
            externalId: "1",
            key: "PROJ-7",
            url: null,
            title: "Add CSV export",
            container: null,
          },
          inlineItem: null,
          actor: null,
          attributes: {},
          extras: {},
          occurredAt: "2026-10-01T00:00:00.000Z",
        },
        agentConfig: AGENT_CONFIG,
        runAsUserId: RUN_AS_USER_ID,
        connectionId: CONNECTION_ID,
        projectId: PROJECT_ID,
        projectConnectionId: null,
        featureDocumentId: null,
        planDocumentId: null,
        phaseStartedAt: new Date("2026-10-01T00:00:00.000Z"),
        stepAttempts: 0,
        nextStepAt: null,
        leaseUntil: null,
        error: null,
        workflow: { name: "Jira to PR", enabled: true },
        ...overrides,
      };
    },
  };
}

export type AdvanceDbFake = ReturnType<typeof createAdvanceDbFake>;

function matchesRun(run: FakeRun, where: Where): boolean {
  if (where.id !== undefined && where.id !== run.id) {
    return false;
  }
  if (!matchesStatus(run.status, where.status)) {
    return false;
  }
  if (where.leaseUntil instanceof Date) {
    return run.leaseUntil?.getTime() === where.leaseUntil.getTime();
  }
  if (where.OR && !where.OR.some((condition) => matchesLease(run, condition))) {
    return false;
  }
  return (where.AND ?? []).every((clause) =>
    clause.OR.some((condition) => matchesNextStep(run, condition))
  );
}

function matchesNextStep(
  run: FakeRun,
  condition: { nextStepAt: null | { lte: Date } }
): boolean {
  const nextStepAt = run.nextStepAt as Date | null | undefined;
  if (condition.nextStepAt === null) {
    return nextStepAt === null || nextStepAt === undefined;
  }
  return (
    nextStepAt instanceof Date &&
    nextStepAt.getTime() <= condition.nextStepAt.lte.getTime()
  );
}

function matchesLease(
  run: FakeRun,
  condition: { leaseUntil: null | { lt: Date } }
): boolean {
  if (condition.leaseUntil === null) {
    return run.leaseUntil === null;
  }
  return (
    run.leaseUntil !== null &&
    run.leaseUntil.getTime() < condition.leaseUntil.lt.getTime()
  );
}

function matchesStatus(status: string, filter: Where["status"]): boolean {
  if (filter === undefined) {
    return true;
  }
  if (typeof filter === "string") {
    return status === filter;
  }
  if (filter.in && !filter.in.includes(status)) {
    return false;
  }
  return !filter.notIn?.includes(status);
}
