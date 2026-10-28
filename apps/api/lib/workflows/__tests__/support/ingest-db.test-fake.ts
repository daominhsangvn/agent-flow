import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { vi } from "vitest";
import { z } from "zod";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import type {
  InboundEvent,
  IntegrationTriggerDefinition,
} from "@/lib/integrations/types";

/**
 * In-memory stand-in for the Prisma delegates lib/workflows/engine/ingest.ts
 * uses: deliveries (unique per connection + deliveryId), triggers joined to
 * their workflow, runs (unique per workflow + dedupKey, occurrence keys of
 * resumes) and the advisory lock statement. Only the query shapes ingest
 * issues are implemented.
 */

export const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
export const CONNECTION_ID = "0199a5f0-0000-7000-8000-00000000000c";
export const WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f1";
export const TRIGGER_ID = "0199a5f0-0000-7000-8000-0000000000e1";
export const RUN_AS_USER_ID = "0199a5f0-0000-7000-8000-0000000000a1";
export const TRIGGER_TYPE = "fake.issue_assigned";
export const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
export const PROJECT_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000b1";
export const SITE_URL = "https://acme.atlassian.net";
export const PRISMA_DB_NULL = "__db_null__";

export type Row = Record<string, unknown> & { id: string };

type Where = Record<string, unknown>;

/** Fake trigger definition: filters on attributes.projectKey. */
export const fakeTriggerDefinition: IntegrationTriggerDefinition<{
  projectKeys: string[];
}> = {
  key: TRIGGER_TYPE,
  displayName: "Issue assigned",
  description: "test",
  configSchema: z.object({ projectKeys: z.array(z.string()).min(1) }),
  configFields: [],
  manualRun: { label: "Issue key", placeholder: "PROJ-1" },
  matches: (event, config) =>
    config.projectKeys.includes(String(event.attributes.projectKey)),
};

export function createIngestDbFake() {
  const deliveries: Row[] = [];
  const runs: Row[] = [];
  const triggers: Row[] = [];
  const scopes: Array<{
    scopeKey: string;
    projectConnectionId: string;
    connectionId: string;
  }> = [];
  const workflows = new Map<string, Row>();
  const connectionUpdates: Where[] = [];
  let nextRunId = 1;
  let failCreateWith: unknown = null;
  let createWinner: Partial<Row> | null = null;
  const commentRefs = {
    toolCalls: [] as CommentRef[],
    actionRuns: [] as CommentRef[],
  };

  const db = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    integrationDelivery: {
      createMany: vi.fn((args: { data: Row[] }) => {
        let count = 0;
        for (const row of args.data) {
          const exists = deliveries.some(
            (delivery) =>
              delivery.connectionId === row.connectionId &&
              delivery.deliveryId === row.deliveryId
          );
          if (!exists) {
            deliveries.push({ ...row });
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
      updateMany: vi.fn((args: { where: Where; data: Where }) => {
        const rows = deliveries.filter((row) => row.id === args.where.id);
        for (const row of rows) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      }),
      deleteMany: vi.fn((args: { where: Where }) => {
        const index = deliveries.findIndex((row) => row.id === args.where.id);
        if (index >= 0) {
          deliveries.splice(index, 1);
        }
        return Promise.resolve({ count: index >= 0 ? 1 : 0 });
      }),
    },
    integrationConnection: {
      updateMany: vi.fn((args: { where: Where; data: Where }) => {
        connectionUpdates.push(args.data);
        return Promise.resolve({ count: 1 });
      }),
    },
    projectConnectionScope: {
      findMany: vi.fn(
        (args: {
          where: {
            scopeKey: { in: string[] };
            projectConnection: { connectionId: string };
          };
        }) =>
          Promise.resolve(
            scopes
              .filter(
                (scope) =>
                  args.where.scopeKey.in.includes(scope.scopeKey) &&
                  scope.connectionId ===
                    args.where.projectConnection.connectionId
              )
              .map((scope) => ({
                scopeKey: scope.scopeKey,
                projectConnectionId: scope.projectConnectionId,
              }))
          )
      ),
    },
    workflowTrigger: {
      findMany: vi.fn((args: { where: Where }) =>
        Promise.resolve(
          triggers
            .filter((trigger) =>
              matchesTriggerWhere(trigger, args.where, workflows)
            )
            .map((trigger) => ({
              ...trigger,
              workflow: workflows.get(String(trigger.workflowId)),
            }))
        )
      ),
    },
    workflow: {
      updateMany: vi.fn((args: { where: Where; data: Where }) => {
        const workflow = workflows.get(String(args.where.id));
        if (workflow) {
          Object.assign(workflow, args.data);
        }
        return Promise.resolve({ count: workflow ? 1 : 0 });
      }),
    },
    // The comments runs posted (answer-replies.ts): tool calls and actions.
    integrationToolCall: {
      findMany: vi.fn((args: { where: CommentRefWhere }) =>
        Promise.resolve(matchCommentRefs(commentRefs.toolCalls, args.where))
      ),
    },
    workflowActionRun: {
      findMany: vi.fn((args: { where: CommentRefWhere }) =>
        Promise.resolve(matchCommentRefs(commentRefs.actionRuns, args.where))
      ),
    },
    workflowRun: {
      findMany: vi.fn((args: { where: Where }) =>
        Promise.resolve(
          runs
            .filter(
              (row) =>
                row.organizationId === args.where.organizationId &&
                row.sourceKey === args.where.sourceKey &&
                row.status === args.where.status &&
                (row.projectConnectionId ?? PROJECT_CONNECTION_ID) ===
                  args.where.projectConnectionId
            )
            .map((row) => ({ id: row.id, workflowId: row.workflowId }))
        )
      ),
      findFirst: vi.fn((args: { where: RunWhere }) => {
        if (args.where.OR) {
          return Promise.resolve(findOccurrence(runs, args.where));
        }
        return Promise.resolve(findActive(runs, args.where));
      }),
      create: vi.fn((args: { data: Where }) => {
        if (failCreateWith) {
          if (createWinner) {
            runs.push({ id: "run-winner", ...createWinner, ...args.data });
          }
          return Promise.reject(failCreateWith);
        }
        const run: Row = { id: `run-${nextRunId++}`, cycle: 1, ...args.data };
        runs.push(run);
        return Promise.resolve({ id: run.id });
      }),
      updateMany: vi.fn((args: { where: Where; data: Where }) => {
        const rows = runs.filter(
          (row) =>
            row.id === args.where.id &&
            row.status === args.where.status &&
            (args.where.cycle === undefined || row.cycle === args.where.cycle)
        );
        for (const row of rows) {
          applyUpdate(row, args.data);
        }
        return Promise.resolve({ count: rows.length });
      }),
    },
  };

  return {
    db,
    deliveries,
    runs,
    triggers,
    workflows,
    connectionUpdates,
    /** The next run insert fails; with a winner, a concurrent insert of the same row won first. */
    failNextCreate(error: unknown, winner: Partial<Row> | null = null) {
      failCreateWith = error;
      createWinner = winner;
    },
    addWorkflow(overrides: Partial<Row> = {}) {
      workflows.set(WORKFLOW_ID, {
        id: WORKFLOW_ID,
        enabled: true,
        runAsUserId: RUN_AS_USER_ID,
        agentConfig: { computeTargetId: "ct-1", mode: WorkflowAgentMode.Plan },
        ...overrides,
      });
    },
    /** Claims the container (a Jira project key) for a project connection of a connection. */
    addScope(
      container: string,
      projectConnectionId = PROJECT_CONNECTION_ID,
      connectionId = CONNECTION_ID
    ) {
      scopes.push({
        scopeKey: `${IntegrationProviderKey.Jira}:${SITE_URL}:${container}`,
        projectConnectionId,
        connectionId,
      });
    },
    addTrigger(overrides: Partial<Row> = {}) {
      triggers.push({
        id: TRIGGER_ID,
        organizationId: ORG_ID,
        connectionId: CONNECTION_ID,
        projectId: PROJECT_ID,
        projectConnectionId: PROJECT_CONNECTION_ID,
        workflowId: WORKFLOW_ID,
        type: TRIGGER_TYPE,
        enabled: true,
        config: { projectKeys: ["PROJ"] },
        ...overrides,
      });
    },
    /** A comment the run posted, by its external ref (a tool call, else an action). */
    addRunComment(
      runId: string,
      externalRef: string,
      via: CommentVia = "tool"
    ) {
      const rows =
        via === "tool" ? commentRefs.toolCalls : commentRefs.actionRuns;
      rows.push({ runId, externalRef });
    },
    addRun(overrides: Partial<Row> & { status: string }): Row {
      const run: Row = {
        id: `run-${nextRunId++}`,
        organizationId: ORG_ID,
        workflowId: WORKFLOW_ID,
        dedupKey: "existing",
        occurrenceKeys: [],
        sourceKey: `${IntegrationProviderKey.Jira}:PROJ-7`,
        cycle: 1,
        ...overrides,
      };
      runs.push(run);
      return run;
    },
  };
}

export type IngestDbFake = ReturnType<typeof createIngestDbFake>;

export function buildLoadedConnection(
  connectionId = CONNECTION_ID
): LoadedConnection {
  return {
    record: {
      id: connectionId,
      organizationId: ORG_ID,
      provider: IntegrationProviderKey.Jira,
      name: "Jira",
    },
    provider: {
      key: IntegrationProviderKey.Jira,
      displayName: "Jira",
      project: {
        containers: (settings: { projectKeys: string[] }) =>
          settings.projectKeys,
        normalizeContainer: (container: string) => container.toUpperCase(),
        origin: (config: { siteUrl: string }) => config.siteUrl,
        triggerContainersField: "projectKeys",
      },
    },
    runtime: {
      id: connectionId,
      organizationId: ORG_ID,
      provider: IntegrationProviderKey.Jira,
      name: "Jira",
      config: { siteUrl: SITE_URL },
      secrets: {},
      account: null,
    },
  } as unknown as LoadedConnection;
}

export function buildEvent(
  overrides: Partial<InboundEvent> = {}
): InboundEvent {
  return {
    triggerType: TRIGGER_TYPE,
    dedupKey: "PROJ-7:assignee:100",
    occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    actor: { id: "ba-1", displayName: "Ada BA" },
    item: {
      provider: IntegrationProviderKey.Jira,
      externalId: "10007",
      key: "PROJ-7",
      url: "https://acme.atlassian.net/browse/PROJ-7",
      title: "Add CSV export",
      container: "PROJ",
    },
    attributes: { projectKey: "PROJ" },
    ...overrides,
  };
}

function matchesTriggerWhere(
  trigger: Row,
  where: Where,
  workflows: Map<string, Row>
): boolean {
  if (where.id !== undefined && trigger.id !== where.id) {
    return false;
  }
  if (
    trigger.organizationId !== where.organizationId ||
    trigger.connectionId !== where.connectionId
  ) {
    return false;
  }
  if (where.enabled !== undefined && trigger.enabled !== where.enabled) {
    return false;
  }
  const types = (where.type as { in?: string[] } | undefined)?.in;
  if (types && !types.includes(String(trigger.type))) {
    return false;
  }
  const workflowFilter = where.workflow as { enabled?: boolean } | undefined;
  const workflow = workflows.get(String(trigger.workflowId));
  return !(
    workflowFilter?.enabled !== undefined &&
    workflow?.enabled !== workflowFilter.enabled
  );
}

type RunWhere = {
  workflowId: string;
  sourceKey?: string;
  status?: { in: string[] };
  OR?: Array<{
    dedupKey?: string;
    sourceKey?: string;
    occurrenceKeys?: { has: string };
  }>;
};

/** findRunByOccurrence: dedupKey, or an occurrence key of the same item. */
function findOccurrence(runs: Row[], where: RunWhere): { id: string } | null {
  const conditions = where.OR ?? [];
  const run = runs.find(
    (row) =>
      row.workflowId === where.workflowId &&
      conditions.some((condition) => matchesOccurrence(row, condition))
  );
  return run ? { id: run.id } : null;
}

function matchesOccurrence(
  row: Row,
  condition: NonNullable<RunWhere["OR"]>[number]
): boolean {
  if (condition.dedupKey !== undefined) {
    return row.dedupKey === condition.dedupKey;
  }
  const keys = (row.occurrenceKeys as string[] | undefined) ?? [];
  return (
    row.sourceKey === condition.sourceKey &&
    condition.occurrenceKeys !== undefined &&
    keys.includes(condition.occurrenceKeys.has)
  );
}

/** The latest active run of the item. */
function findActive(runs: Row[], where: RunWhere) {
  const latest = runs
    .filter(
      (row) =>
        row.workflowId === where.workflowId &&
        row.sourceKey === where.sourceKey &&
        (where.status?.in.includes(String(row.status)) ?? true)
    )
    .at(-1);
  return latest
    ? { id: latest.id, status: latest.status, cycle: latest.cycle }
    : null;
}

function applyUpdate(row: Row, data: Where): void {
  for (const [key, value] of Object.entries(data)) {
    const operation = value as { increment?: number; push?: string } | null;
    if (typeof operation?.increment === "number") {
      row[key] = Number(row[key] ?? 0) + operation.increment;
    } else if (typeof operation?.push === "string") {
      row[key] = [
        ...((row[key] as string[] | undefined) ?? []),
        operation.push,
      ];
    } else {
      row[key] = value;
    }
  }
}

type CommentVia = "tool" | "action";

type CommentRef = { runId: string; externalRef: string };

type CommentRefWhere = { runId: { in: string[] }; externalRef: string };

function matchCommentRefs(
  refs: readonly CommentRef[],
  where: CommentRefWhere
): Array<{ runId: string }> {
  return refs
    .filter(
      (ref) =>
        where.runId.in.includes(ref.runId) &&
        ref.externalRef === where.externalRef
    )
    .map((ref) => ({ runId: ref.runId }));
}
