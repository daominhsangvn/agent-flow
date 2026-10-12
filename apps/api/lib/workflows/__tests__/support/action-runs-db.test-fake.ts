import {
  WorkflowActionRunStatus,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { vi } from "vitest";

/**
 * In-memory stand-in for the workflow_actions / workflow_action_runs
 * delegates lib/workflows/engine/actions.ts and pre-actions.ts use. Where
 * clauses support equality, Date equality, { in, notIn, lt, lte, gte, has,
 * hasSome } and OR, which covers every query shape of the engine. updateMany
 * and updateManyAndReturn (the claim; honours `select`) stamp updatedAt like
 * Prisma's @updatedAt.
 */

export type FakeRow = Record<string, unknown> & { id: string };

type Where = Record<string, unknown> & { OR?: Where[] };

type Condition = {
  in?: unknown[];
  notIn?: unknown[];
  lt?: unknown;
  lte?: unknown;
  gte?: unknown;
  has?: unknown;
  hasSome?: unknown[];
};

export function createActionRunsDbFake() {
  const actionRuns: FakeRow[] = [];
  const actions: FakeRow[] = [];
  let nextId = 1;

  const workflowActionRun = {
    findMany: vi.fn(
      (args: {
        where: Where;
        include?: { action?: unknown };
        orderBy?: unknown;
        take?: number;
      }) => {
        const rows = actionRuns
          .filter((row) => matchesWhere(row, args.where))
          .sort(byCreatedAt)
          .slice(0, args.take ?? Number.POSITIVE_INFINITY)
          // Rows are read as snapshots, like a database read.
          .map((row) => ({
            ...row,
            ...(args.include?.action ? { action: joinAction(row) } : {}),
          }));
        return Promise.resolve(rows);
      }
    ),
    findFirst: vi.fn((args: { where: Where }) => {
      const row = actionRuns.find((entry) => matchesWhere(entry, args.where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    updateMany: vi.fn(
      (args: { where: Where; data: Record<string, unknown> }) => {
        const rows = actionRuns.filter((row) => matchesWhere(row, args.where));
        for (const row of rows) {
          applyUpdate(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      }
    ),
    updateManyAndReturn: vi.fn(
      (args: {
        where: Where;
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const rows = actionRuns.filter((row) => matchesWhere(row, args.where));
        for (const row of rows) {
          applyUpdate(row, args.data);
        }
        return Promise.resolve(rows.map((row) => pick(row, args.select)));
      }
    ),
    createMany: vi.fn(
      (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          if (actionRuns.some((row) => sameOccurrence(row, data))) {
            continue;
          }
          actionRuns.push(newActionRun(data));
          count += 1;
        }
        return Promise.resolve({ count });
      }
    ),
  };

  const workflowAction = {
    findMany: vi.fn((args: { where: Where }) =>
      Promise.resolve(
        actions
          .filter((row) => matchesWhere(row, args.where))
          .sort((left, right) => Number(left.position) - Number(right.position))
          .map((row) => ({ ...row }))
      )
    ),
    findFirst: vi.fn((args: { where: Where }) => {
      const row = actions.find((entry) => matchesWhere(entry, args.where));
      return Promise.resolve(row ? { ...row } : null);
    }),
  };

  function joinAction(row: FakeRow) {
    const action = actions.find((entry) => entry.id === row.actionId);
    return action
      ? { position: action.position, continueOnError: action.continueOnError }
      : null;
  }

  function newActionRun(data: Record<string, unknown>): FakeRow {
    const now = new Date();
    return {
      id: `ar-${nextId++}`,
      stage: WorkflowActionStage.Post,
      cycle: 1,
      status: WorkflowActionRunStatus.Pending,
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      externalRef: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    };
  }

  return {
    db: { workflowActionRun, workflowAction },
    actionRuns,
    actions,
    /** Adds a workflow action (post stage on run.succeeded by default). */
    addAction(overrides: Partial<FakeRow> & { id: string }): FakeRow {
      const row: FakeRow = {
        organizationId: "org-1",
        workflowId: "workflow-1",
        connectionId: "conn-1",
        type: "fake.action",
        config: {},
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        continueOnError: false,
        enabled: true,
        position: 0,
        ...overrides,
      };
      actions.push(row);
      return row;
    },
    /** Adds an action run row as it would be stored. */
    addActionRun(overrides: Partial<FakeRow> = {}): FakeRow {
      const row = newActionRun({
        organizationId: "org-1",
        runId: "run-1",
        actionId: "action-1",
        actionType: "fake.action",
        event: WorkflowRunEvent.Succeeded,
        ...overrides,
      });
      actionRuns.push(row);
      return row;
    },
  };
}

export type ActionRunsDbFake = ReturnType<typeof createActionRunsDbFake>;

export function matchesWhere(row: FakeRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Where[]).some((entry) => matchesWhere(row, entry));
    }
    return matchesCondition(row[key], condition);
  });
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (isConditionObject(condition)) {
    return matchesOperators(value, condition);
  }
  return value === condition;
}

function matchesOperators(value: unknown, condition: Condition): boolean {
  const checks: boolean[] = [];
  if (condition.in) {
    checks.push(condition.in.includes(value));
  }
  if (condition.notIn) {
    checks.push(!condition.notIn.includes(value));
  }
  if (condition.lt !== undefined) {
    checks.push(compare(value, condition.lt) < 0);
  }
  if (condition.lte !== undefined) {
    checks.push(compare(value, condition.lte) <= 0);
  }
  if (condition.gte !== undefined) {
    checks.push(compare(value, condition.gte) >= 0);
  }
  if (condition.has !== undefined) {
    checks.push(Array.isArray(value) && value.includes(condition.has));
  }
  if (condition.hasSome) {
    const hasSome = condition.hasSome;
    checks.push(
      Array.isArray(value) && value.some((entry) => hasSome.includes(entry))
    );
  }
  return checks.every(Boolean);
}

function isConditionObject(value: unknown): value is Condition {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function compare(left: unknown, right: unknown): number {
  return toNumber(left) - toNumber(right);
}

function toNumber(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

function applyUpdate(row: FakeRow, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    const increment = (value as { increment?: number } | null)?.increment;
    row[key] =
      typeof increment === "number" ? Number(row[key]) + increment : value;
  }
  row.updatedAt = new Date();
}

/** A copy of the row, limited to the selected fields when a select is given. */
function pick(
  row: FakeRow,
  select: Record<string, boolean> | undefined
): Record<string, unknown> {
  if (!select) {
    return { ...row };
  }
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]])
  );
}

function sameOccurrence(row: FakeRow, data: Record<string, unknown>): boolean {
  return (
    row.runId === data.runId &&
    row.actionId === data.actionId &&
    row.event === data.event &&
    row.cycle === data.cycle
  );
}

function byCreatedAt(left: FakeRow, right: FakeRow): number {
  return compare(left.createdAt, right.createdAt);
}
