import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
} from "@repo/api/src/types/integration";
import { vi } from "vitest";

/**
 * In-memory stand-in for the `integrationConnection` / `integrationDelivery`
 * Prisma delegates used by lib/integrations/connection-service.ts. It
 * implements just the query shapes the service issues: equality `where`
 * clauses, the `triggers/actions/projectRepositories/projectConnections:
 * { none: {} }` filters of the guarded delete, `include: { _count }`, upserts
 * by id, and `Prisma.DbNull` writes. `projectConnection.updateMany` records
 * the project accounts retired when a connection's site changes.
 */

/** Value the test's `@repo/database` mock exposes as `Prisma.DbNull`. */
export const PRISMA_DB_NULL = "__prisma_db_null__";

export type FakeRow = Record<string, unknown> & { id: string };

type Usage = {
  triggers: number;
  actions: number;
  projectRepositories: number;
  projectConnections: number;
};

type QueryArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  include?: { _count?: unknown };
  take?: number;
};

type UpsertArgs = {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

const CONNECTION_DEFAULTS = {
  status: IntegrationConnectionStatus.Active,
  config: {},
  credentialsEncrypted: null,
  credentialHints: {},
  account: null,
  inboundSecretEncrypted: null,
  deliveryMode: IntegrationDeliveryMode.None,
  pollIntervalSeconds: 120,
  pollCursor: null,
  nextPollAt: null,
  lastPolledAt: null,
  lastDeliveryAt: null,
  lastValidatedAt: null,
  lastError: null,
  createdById: null,
};

export const connectionDbFake = createConnectionDbFake();

function createConnectionDbFake() {
  const connections = new Map<string, FakeRow>();
  const usage = new Map<string, Usage>();
  const deliveries: FakeRow[] = [];

  const usageOf = (id: string): Usage => usage.get(id) ?? NO_USAGE;
  const findRows = (where: QueryArgs["where"]) =>
    [...connections.values()].filter((row) =>
      matchesWhere(row, where, usageOf(row.id))
    );
  const decorate = (row: FakeRow, include: QueryArgs["include"]) =>
    include?._count ? { ...row, _count: usageOf(row.id) } : { ...row };
  const findFirst = (args: QueryArgs) => {
    const [row] = findRows(args.where);
    return Promise.resolve(row ? decorate(row, args.include) : null);
  };
  const insert = (data: Record<string, unknown>): FakeRow => {
    const now = new Date();
    const row: FakeRow = {
      ...CONNECTION_DEFAULTS,
      ...normalizeWrite(data),
      id: String(data.id),
      createdAt: now,
      updatedAt: now,
    };
    connections.set(row.id, row);
    return row;
  };

  const db = {
    integrationConnection: {
      findMany: vi.fn((args: QueryArgs) =>
        Promise.resolve(
          findRows(args.where).map((row) => decorate(row, args.include))
        )
      ),
      findFirst: vi.fn(findFirst),
      findUnique: vi.fn(findFirst),
      create: vi.fn((args: QueryArgs) =>
        Promise.resolve(decorate(insert(args.data ?? {}), args.include))
      ),
      upsert: vi.fn((args: UpsertArgs) => {
        const [row] = findRows(args.where);
        if (!row) {
          return Promise.resolve({ ...insert(args.create) });
        }
        Object.assign(row, normalizeWrite(args.update), {
          updatedAt: new Date(),
        });
        return Promise.resolve({ ...row });
      }),
      update: vi.fn((args: QueryArgs) => {
        const [row] = findRows(args.where);
        if (!row) {
          return Promise.reject(new Error("Record to update not found"));
        }
        Object.assign(row, normalizeWrite(args.data), {
          updatedAt: new Date(),
        });
        return Promise.resolve(decorate(row, args.include));
      }),
      updateMany: vi.fn((args: QueryArgs) => {
        const rows = findRows(args.where);
        for (const row of rows) {
          Object.assign(row, normalizeWrite(args.data), {
            updatedAt: new Date(),
          });
        }
        return Promise.resolve({ count: rows.length });
      }),
      deleteMany: vi.fn((args: QueryArgs) => {
        const rows = findRows(args.where);
        for (const row of rows) {
          connections.delete(row.id);
        }
        return Promise.resolve({ count: rows.length });
      }),
    },
    projectConnection: {
      updateMany: vi.fn((_args: QueryArgs) => Promise.resolve({ count: 0 })),
    },
    integrationDelivery: {
      findMany: vi.fn((args: QueryArgs) =>
        Promise.resolve(
          deliveries
            .filter((row) => matchesWhere(row, args.where, NO_USAGE))
            .sort(byReceivedAtDesc)
            .slice(0, args.take)
        )
      ),
    },
  };

  return {
    db,
    connections,
    usage,
    deliveries,
    reset() {
      connections.clear();
      usage.clear();
      deliveries.length = 0;
    },
  };
}

const NO_USAGE: Usage = {
  triggers: 0,
  actions: 0,
  projectRepositories: 0,
  projectConnections: 0,
};

function matchesWhere(
  row: FakeRow,
  where: QueryArgs["where"],
  rowUsage: Usage
): boolean {
  return Object.entries(where ?? {}).every(([key, expected]) =>
    matchesClause(row, key, expected, rowUsage)
  );
}

/** The service only uses `{ none: {} }` on the relations, i.e. "unused". */
function matchesClause(
  row: FakeRow,
  key: string,
  expected: unknown,
  rowUsage: Usage
): boolean {
  if (key === "triggers") {
    return rowUsage.triggers === 0;
  }
  if (key === "actions") {
    return rowUsage.actions === 0;
  }
  if (key === "projectRepositories") {
    return rowUsage.projectRepositories === 0;
  }
  if (key === "projectConnections") {
    return rowUsage.projectConnections === 0;
  }
  return row[key] === expected;
}

/** Prisma ignores undefined fields and stores DbNull as SQL NULL. */
function normalizeWrite(
  data: Record<string, unknown> = {}
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === PRISMA_DB_NULL ? null : value])
  );
}

function byReceivedAtDesc(left: FakeRow, right: FakeRow): number {
  return (
    (right.receivedAt as Date).getTime() - (left.receivedAt as Date).getTime()
  );
}
