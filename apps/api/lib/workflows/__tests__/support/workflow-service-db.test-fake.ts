import { vi } from "vitest";
import { projectDelegates } from "@/lib/workflows/__tests__/support/workflow-projects.test-fake";

/**
 * The project delegates plus the `user`, `integrationConnection`, `workflow`, child row and `workflowRun`
 * delegates the workflow-service suite needs, backed by the suite's mutable
 * state so each test can arrange rows and assert on recorded writes.
 */

type Row = Record<string, unknown> & { id: string };

export type WorkflowServiceDbState = {
  projectExists: boolean;
  activeUsers: Set<string>;
  connections: Row[];
  workflow: Row | null;
  triggers: Row[];
  actions: Row[];
  runGroups: Array<{
    workflowId: string;
    status: string;
    _count: { _all: number };
  }>;
  writes: string[];
};

export function workflowServiceDelegates(
  state: WorkflowServiceDbState,
  context: () => { projectId: string; keyByConnection: Record<string, string> }
) {
  return {
    ...projectDelegates({
      projectExists: () => state.projectExists,
      connections: () => state.connections,
    }),
    user: {
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(
          state.activeUsers.has(args.where.id) ? { id: args.where.id } : null
        )
      ),
    },
    integrationConnection: {
      findMany: vi.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          state.connections.filter((row) => args.where.id.in.includes(row.id))
        )
      ),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    workflow: {
      create: vi.fn((args: { data: Row }) => {
        state.workflow = {
          ...args.data,
          id: "0199a5f0-0000-7000-8000-0000000000f1",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
        };
        return Promise.resolve({ id: state.workflow.id });
      }),
      updateMany: vi.fn((args: { data: Row }) => {
        state.writes.push("workflow.update");
        Object.assign(state.workflow ?? {}, args.data);
        return Promise.resolve({ count: 1 });
      }),
      deleteMany: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve({ count: state.workflow?.id === args.where.id ? 1 : 0 })
      ),
      findMany: vi.fn(() => Promise.resolve(state.workflow ? [record()] : [])),
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(state.workflow?.id === args.where.id ? record() : null)
      ),
    },
    workflowTrigger: childDelegate(() => state.triggers, "trigger"),
    workflowAction: childDelegate(() => state.actions, "action"),
    workflowRun: {
      groupBy: vi.fn(() => Promise.resolve(state.runGroups)),
    },
    orchestratorCase: { groupBy: vi.fn(() => Promise.resolve([])) },
  };

  function record() {
    const { projectId, keyByConnection } = context();
    return {
      ...state.workflow,
      project: { id: "project", name: "Platform" },
      runAsUser: {
        id: state.workflow?.runAsUserId,
        firstName: "Bot",
        lastName: null,
        email: "bot@example.test",
      },
      triggers: [...state.triggers].sort(byPosition).map((row) => ({
        projectId,
        projectConnectionId: `pc-${String(row.connectionId)}`,
        projectConnection: { key: keyByConnection[String(row.connectionId)] },
        ...row,
      })),
      actions: [...state.actions].sort(byPosition),
    };
  }

  function childDelegate(rows: () => Row[], label: string) {
    let next = 1;
    return {
      deleteMany: vi.fn((args: { where: { id: { notIn: string[] } } }) => {
        const keep = rows().filter((row) =>
          args.where.id.notIn.includes(row.id)
        );
        rows().splice(0, rows().length, ...keep);
        state.writes.push(`${label}.delete`);
        return Promise.resolve({ count: 0 });
      }),
      updateMany: vi.fn((args: { where: { id: string }; data: Row }) => {
        const row = rows().find((entry) => entry.id === args.where.id);
        Object.assign(row ?? {}, args.data);
        state.writes.push(`${label}.update:${args.where.id}`);
        return Promise.resolve({ count: row ? 1 : 0 });
      }),
      create: vi.fn((args: { data: Row }) => {
        const row = { ...args.data, id: `${label}-new-${next++}` };
        rows().push(row);
        state.writes.push(`${label}.create`);
        return Promise.resolve({ id: row.id });
      }),
    };
  }
}

function byPosition(left: Row, right: Row) {
  return Number(left.position) - Number(right.position);
}
