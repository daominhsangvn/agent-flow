import { vi } from "vitest";

/**
 * In-memory stand-in for the Prisma delegates project-connection-service.ts
 * uses: projects, integration connections (existence and the name/provider
 * include), project connections and their scopes. `where` supports equality
 * (null included), `{ not }` and `{ in }`; includes and selects return the
 * related rows the service reads; a scope lookup also filters on its project
 * connection (`projectConnection: { ... }`). `$executeRaw` records the
 * advisory locks.
 */

/** Value the test's `@repo/database` mock exposes as `Prisma.DbNull`. */
export const PRISMA_DB_NULL = "__prisma_db_null__";

type Row = Record<string, unknown> & { id: string };

type Where = Record<string, unknown>;

type FindArgs = {
  where?: Where;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
};

export const projectConnectionDbFake = createFake();

function createFake() {
  const projects = new Map<string, Row>();
  const connections = new Map<string, Row>();
  const projectConnections = new Map<string, Row>();
  const scopes = new Map<string, Row>();
  const locks: string[] = [];
  /** Workflows findUsers reads (name, agentConfig, triggers, actions). */
  const workflows: Record<string, unknown>[] = [];
  let sequence = 0;

  const nextId = () => {
    sequence += 1;
    return `0199a5f0-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
  };
  const filter = (rows: Map<string, Row>, where: Where | undefined) =>
    [...rows.values()].filter((row) => matchesWhere(row, where));
  const withRelations = (row: Row) => ({
    ...row,
    connection: connections.get(String(row.connectionId)) ?? null,
    project: projects.get(String(row.projectId)) ?? null,
  });
  const scopeWithOwner = (row: Row) => ({
    ...row,
    projectConnection: withRelations(
      projectConnections.get(String(row.projectConnectionId)) as Row
    ),
  });

  const db = {
    $executeRaw: vi.fn(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push(String(values[0]));
        return Promise.resolve(1);
      }
    ),
    workflow: {
      findMany: vi.fn(() => Promise.resolve(workflows)),
    },
    project: {
      findFirst: vi.fn((args: FindArgs) =>
        Promise.resolve(filter(projects, args.where)[0] ?? null)
      ),
    },
    integrationConnection: {
      findFirst: vi.fn((args: FindArgs) =>
        Promise.resolve(filter(connections, args.where)[0] ?? null)
      ),
    },
    projectConnection: {
      findMany: vi.fn((args: FindArgs) =>
        Promise.resolve(
          filter(projectConnections, args.where)
            .sort(byCreatedAt)
            .map(withRelations)
        )
      ),
      findFirst: vi.fn((args: FindArgs) => {
        const [row] = filter(projectConnections, args.where);
        return Promise.resolve(row ? withRelations(row) : null);
      }),
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        const now = new Date(Date.now() + sequence);
        const row: Row = {
          ...normalizeWrite(args.data),
          id: nextId(),
          createdAt: now,
          updatedAt: now,
        };
        projectConnections.set(row.id, row);
        return Promise.resolve(withRelations(row));
      }),
      update: vi.fn((args: { where: Where; data: Record<string, unknown> }) => {
        const [row] = filter(projectConnections, args.where);
        if (!row) {
          return Promise.reject(new Error("Record to update not found"));
        }
        Object.assign(row, normalizeWrite(args.data), {
          updatedAt: new Date(),
        });
        return Promise.resolve(withRelations(row));
      }),
      deleteMany: vi.fn((args: FindArgs) => {
        const rows = filter(projectConnections, args.where);
        for (const row of rows) {
          projectConnections.delete(row.id);
          for (const scope of filter(scopes, {
            projectConnectionId: row.id,
          })) {
            scopes.delete(scope.id);
          }
        }
        return Promise.resolve({ count: rows.length });
      }),
    },
    projectConnectionScope: {
      findFirst: vi.fn((args: FindArgs) => {
        const { projectConnection: ownerWhere, ...where } = args.where ?? {};
        const row = filter(scopes, where)
          .map(scopeWithOwner)
          .find((scope) =>
            matchesWhere(scope.projectConnection, ownerWhere as Where)
          );
        return Promise.resolve(row ?? null);
      }),
      deleteMany: vi.fn((args: FindArgs) => {
        const rows = filter(scopes, args.where);
        for (const row of rows) {
          scopes.delete(row.id);
        }
        return Promise.resolve({ count: rows.length });
      }),
      createMany: vi.fn((args: { data: Record<string, unknown>[] }) => {
        for (const data of args.data) {
          const row: Row = { ...data, id: nextId(), createdAt: new Date() };
          scopes.set(row.id, row);
        }
        return Promise.resolve({ count: args.data.length });
      }),
    },
  };

  return {
    db,
    projects,
    connections,
    projectConnections,
    scopes,
    locks,
    workflows,
    reset() {
      projects.clear();
      connections.clear();
      projectConnections.clear();
      scopes.clear();
      locks.length = 0;
      workflows.length = 0;
      sequence = 0;
    },
    addProject(row: { id: string; organizationId: string; name: string }) {
      projects.set(row.id, { ...row });
    },
    addConnection(row: {
      id: string;
      organizationId: string;
      name: string;
      provider: string;
    }) {
      connections.set(row.id, { ...row });
    },
  };
}

function matchesWhere(row: Row, where: Where | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, expected]) =>
    matchesValue(row[key], expected)
  );
}

function matchesValue(value: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object") {
    if ("not" in expected) {
      return value !== (expected as { not: unknown }).not;
    }
    if ("in" in expected) {
      return (expected as { in: unknown[] }).in.includes(value);
    }
  }
  return (value ?? null) === expected;
}

/** Prisma ignores undefined fields and stores DbNull as SQL NULL. */
function normalizeWrite(
  data: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === PRISMA_DB_NULL ? null : value])
  );
}

function byCreatedAt(left: Row, right: Row): number {
  return (
    (left.createdAt as Date).getTime() - (right.createdAt as Date).getTime()
  );
}
