/**
 * An in-memory stand-in for the orchestrator tables (and the few others the
 * orchestrator engine reads), answering exactly the Prisma calls the engine
 * makes. Unique keys throw P2002 like Postgres.
 */

import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";

type Row = Record<string, unknown>;

export const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
export const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
export const PROJECT_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000e1";
export const RUNNER_ID = "0199a5f0-0000-7000-8000-0000000000c1";

export type OrchestratorDbFake = ReturnType<typeof createOrchestratorDbFake>;

export function createOrchestratorDbFake() {
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const cases: Row[] = [];
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const turns: Row[] = [];
  const anchors: Row[] = [];
  const workflows: Row[] = [];

  const unique = () =>
    Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR") {
        return (value as Row[]).some((part) => matches(row, part));
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const filter = value as Row;
        if ("in" in filter) {
          return (filter.in as unknown[]).includes(row[key]);
        }
        if ("notIn" in filter) {
          return !(filter.notIn as unknown[]).includes(row[key]);
        }
        if ("not" in filter) {
          return row[key] !== filter.not;
        }
        if ("lte" in filter) {
          return row[key] instanceof Date && row[key] <= (filter.lte as Date);
        }
        if ("lt" in filter) {
          return row[key] instanceof Date && row[key] < (filter.lt as Date);
        }
        if ("gt" in filter) {
          return row[key] instanceof Date && row[key] > (filter.gt as Date);
        }
      }
      return row[key] === value;
    });

  const sortBy = (rows: Row[], orderBy?: Row) => {
    if (!orderBy) {
      return rows;
    }
    const [key, direction] = Object.entries(orderBy)[0] as [string, string];
    return [...rows].sort((a, b) => {
      const left = a[key] as Date | string;
      const right = b[key] as Date | string;
      const order = left < right ? -1 : 1;
      return direction === "desc" ? -order : order;
    });
  };

  /** The relation a select of `case: { workflowId, project }` reads. */
  const caseOf = (conversation: Row): Row => {
    const found = cases.find((row) => row.id === conversation.caseId);
    return { ...found, project: { name: "LeaveDesk" } };
  };

  const db = {
    orchestratorAnchor: {
      findUnique: (args: {
        where: { organizationId_provider_externalRef: Row };
      }) => {
        const key = args.where.organizationId_provider_externalRef;
        const anchor = anchors.find((row) => matches(row, key));
        if (!anchor) {
          return Promise.resolve(null);
        }
        const conversation = conversations.find(
          (row) => row.id === anchor.conversationId
        );
        return Promise.resolve({
          conversation: {
            id: conversation?.id,
            projectId: conversation?.projectId,
            case: conversation ? caseOf(conversation) : undefined,
          },
        });
      },
      create: (args: { data: Row }) => {
        if (
          anchors.some(
            (row) =>
              row.provider === args.data.provider &&
              row.externalRef === args.data.externalRef
          )
        ) {
          throw unique();
        }
        anchors.push({ id: nextId("anchor"), ...args.data });
        return Promise.resolve(anchors.at(-1));
      },
    },
    workflow: {
      findMany: (args: { where: Row }) =>
        Promise.resolve(workflows.filter((row) => matches(row, args.where))),
    },
    orchestratorCase: {
      upsert: (args: {
        where: { workflowId_sourceKey: Row };
        create: Row;
        update: Row;
      }) => {
        const found = cases.find((row) =>
          matches(row, args.where.workflowId_sourceKey)
        );
        if (found) {
          Object.assign(found, args.update);
          return Promise.resolve(found);
        }
        cases.push({
          id: nextId("case"),
          status: "open",
          notes: "",
          ...args.create,
        });
        return Promise.resolve(cases.at(-1));
      },
      update: (args: { where: { id: string }; data: Row }) => {
        const found = cases.find((row) => row.id === args.where.id);
        Object.assign(found ?? {}, args.data);
        return Promise.resolve(found);
      },
    },
    orchestratorConversation: {
      findUnique: (args: { where: Row; select?: Row }) => {
        const where = (args.where.caseId_channelKey as Row) ?? args.where;
        const found = conversations.find((row) => matches(row, where));
        if (!found) {
          return Promise.resolve(null);
        }
        const select = args.select as { _count?: unknown } | undefined;
        const withRelations = { ...found, case: caseOf(found) };
        return Promise.resolve(
          select?._count
            ? {
                ...withRelations,
                _count: {
                  turns: turns.filter((row) => row.conversationId === found.id)
                    .length,
                },
              }
            : withRelations
        );
      },
      findMany: (args: { where: Row; orderBy?: Row; take?: number }) =>
        Promise.resolve(
          sortBy(
            conversations.filter((row) => matches(row, args.where)),
            args.orderBy
          )
            .slice(0, args.take)
            .map((row) => ({ ...row, case: caseOf(row) }))
        ),
      findFirst: (args: { where: Row }) => {
        const found = conversations.find((row) => matches(row, args.where));
        return Promise.resolve(
          found ? { ...found, case: caseOf(found) } : null
        );
      },
      create: (args: { data: Row }) => {
        conversations.push({
          id: nextId("conversation"),
          status: "idle",
          sessionId: null,
          leaseUntil: null,
          nextWakeAt: null,
          ...args.data,
        });
        return Promise.resolve(conversations.at(-1));
      },
      update: (args: { where: { id: string }; data: Row }) => {
        const found = conversations.find((row) => row.id === args.where.id);
        Object.assign(found ?? {}, args.data);
        return Promise.resolve(found);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const found = conversations.filter((row) => matches(row, args.where));
        for (const row of found) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: found.length });
      },
    },
    orchestratorMessage: {
      create: (args: { data: Row }) => {
        if (
          messages.some(
            (row) =>
              row.conversationId === args.data.conversationId &&
              row.dedupKey === args.data.dedupKey
          )
        ) {
          throw unique();
        }
        messages.push({
          id: nextId("message"),
          turnId: null,
          createdAt: new Date(Date.UTC(2026, 9, 23, 8, 0, sequence)),
          ...args.data,
        });
        return Promise.resolve(messages.at(-1));
      },
      findMany: (args: { where: Row; orderBy?: Row; take?: number }) =>
        Promise.resolve(
          sortBy(
            messages.filter((row) => matches(row, args.where)),
            args.orderBy
          ).slice(0, args.take)
        ),
      findFirst: (args: { where: Row; orderBy?: Row }) =>
        Promise.resolve(
          sortBy(
            messages.filter((row) => matches(row, args.where)),
            args.orderBy
          )[0] ?? null
        ),
      updateMany: (args: { where: Row; data: Row }) => {
        const found = messages.filter((row) => matches(row, args.where));
        for (const row of found) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: found.length });
      },
    },
    orchestratorTurn: {
      create: (args: { data: Row }) => {
        turns.push({
          id: nextId("turn"),
          commandId: null,
          ended: null,
          tokenHash: null,
          ...args.data,
        });
        return Promise.resolve(turns.at(-1));
      },
      findFirst: (args: { where: Row; orderBy?: Row }) =>
        Promise.resolve(
          sortBy(
            turns.filter((row) => matches(row, args.where)),
            args.orderBy
          )[0] ?? null
        ),
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(turns.find((row) => row.id === args.where.id) ?? null),
      findMany: (args: { where: Row; orderBy?: Row; take?: number }) =>
        Promise.resolve(
          sortBy(
            turns.filter((row) => matches(row, args.where)),
            args.orderBy
          ).slice(0, args.take)
        ),
      update: (args: { where: { id: string }; data: Row }) => {
        const found = turns.find((row) => row.id === args.where.id);
        Object.assign(found ?? {}, args.data);
        return Promise.resolve(found);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const found = turns.filter((row) => matches(row, args.where));
        for (const row of found) {
          Object.assign(row, args.data);
        }
        return Promise.resolve({ count: found.length });
      },
    },
  };

  return {
    db,
    cases,
    conversations,
    messages,
    turns,
    anchors,
    addWorkflow(
      id: string,
      name: string,
      options: { enabled?: boolean; agentConfig?: Row } = {}
    ) {
      workflows.push({
        id,
        name,
        organizationId: ORG_ID,
        description: "",
        enabled: options.enabled ?? true,
        agentConfig: {
          mode: WorkflowAgentMode.Orchestrated,
          computeTargetId: RUNNER_ID,
          instructions: "Rules.",
          orchestrator: { debounceSeconds: 20 },
          ...options.agentConfig,
        },
      });
    },
    addAnchor(conversationId: string, provider: string, externalRef: string) {
      anchors.push({
        id: nextId("anchor"),
        organizationId: ORG_ID,
        conversationId,
        provider,
        externalRef,
      });
    },
  };
}
