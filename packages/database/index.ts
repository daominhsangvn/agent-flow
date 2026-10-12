import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import type {
  TransactionClient,
  TransactionIsolationLevel,
} from "./generated/internal/prismaNamespace";
import { keys } from "./keys";
import {
  DB_POOL_ACQUIRE_TIMEOUT_MS,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
} from "./pool-config";
import { instrumentPool } from "./pool-telemetry";
import { formatSearchPath, resolveSchemaName } from "./schema-utils";
import {
  classifyDatabaseTransport,
  isLocalhostUrl,
  resolveSslOption,
} from "./scripts/db-utils";

// biome-ignore lint/performance/noBarrelFile: re-exporting Prisma client types
export * from "./generated/client";
export type { TransactionClient } from "./generated/internal/prismaNamespace";
// NOTE: the pool ceilings in `./pool-config` are deliberately NOT re-exported
// here. Import them from `@repo/database/pool-config` directly — it is a
// dependency-free leaf, so consumers skip this module's Prisma/pg graph, and
// the many suites that `vi.mock("@repo/database")` do not have to re-export a
// constant they never use (FEA-3299).
export {
  type PoolTelemetryMetric,
  type PoolTelemetrySample,
  type PoolTelemetrySink,
  setPoolTelemetrySink,
} from "./pool-telemetry";

/**
 * Execute a database operation with an initialized Prisma client.
 *
 * @param fn - Callback receiving the initialized PrismaClient. Can be sync or async.
 * @returns The result of the callback function.
 *
 * @example
 * // Simple query
 * const users = await withDb(db => db.user.findMany());
 *
 * @example
 * // Query with parameters
 * const user = await withDb(db =>
 *   db.user.findUnique({ where: { id: userId } })
 * );
 *
 * @example
 * // Multiple operations (not transactional - use withDb.tx for transactions)
 * const [users, projects] = await withDb(async db => {
 *   const users = await db.user.findMany();
 *   const projects = await db.project.findMany();
 *   return [users, projects];
 * });
 */
export async function withDb<T>(
  fn: (db: TransactionClient) => Promise<T> | T
): Promise<T> {
  const tx = als.getStore()?.tx;
  if (tx) {
    return fn(tx);
  }

  const db = await getDatabase();
  return fn(db);
}

export function getDatabaseTransportPosture() {
  return classifyDatabaseTransport({
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    pgDatabase: process.env.PGDATABASE,
    pgUser: process.env.PGUSER,
    allowInsecureSsl: process.env.ALLOW_INSECURE_SSL === "1",
  });
}

/**
 * Execute multiple database operations within a transaction.
 *
 * Wraps operations in a Prisma interactive transaction, ensuring all operations
 * either succeed together or roll back on failure.
 *
 * @param fn - Callback receiving a transaction client. Must be async.
 * @returns The result of the callback function.
 *
 * @example
 * // Create related records atomically
 * const { user, profile } = await withDb.tx(async tx => {
 *   const user = await tx.user.create({ data: { email } });
 *   const profile = await tx.profile.create({
 *     data: { userId: user.id, name }
 *   });
 *   return { user, profile };
 * });
 *
 * @example
 * // Update with optimistic locking pattern
 * await withDb.tx(async tx => {
 *   const artifact = await tx.artifact.findUniqueOrThrow({
 *     where: { id }
 *   });
 *   await tx.artifact.update({
 *     where: { id, version: artifact.version },
 *     data: { content, version: artifact.version + 1 }
 *   });
 * });
 *
 * @param options - Optional Prisma interactive-transaction options. Use
 *   `timeout` to raise the default 5s limit for long-running transactions (e.g.
 *   large cascade deletes), `maxWait` to bound how long to wait for a
 *   connection, and `isolationLevel` to force a stronger snapshot than the
 *   default READ COMMITTED — e.g. `RepeatableRead` so a set of reads share one
 *   MVCC snapshot and cannot observe a row a concurrent commit relinked between
 *   them (ISS-4669), nor disagree about a page and its total because a row was
 *   inserted or deleted between the two reads (ISS-4576). `timeout`/`maxWait`
 *   are ignored when already inside an
 *   ambient transaction (the callback simply joins it), but `isolationLevel` is
 *   NOT silently dropped: joining an ambient transaction that was opened at a
 *   weaker level (the default READ COMMITTED) would give the caller a snapshot
 *   that does not satisfy the guarantee it asked for — the exact undercount /
 *   double-count ISS-4669 closes — so requesting an `isolationLevel` while an
 *   ambient transaction is active throws (fail closed) rather than returning a
 *   silently-wrong result. Callers needing that snapshot must be the outermost
 *   transaction (or the ambient one must already provide it).
 */
withDb.tx = async <T>(
  fn: (tx: TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: TransactionIsolationLevel;
  }
): Promise<T> => {
  const tx = als.getStore()?.tx;
  if (tx) {
    // wongk (ISS-4669): an explicit `isolationLevel` cannot be honored by
    // joining an ambient transaction — Postgres fixes isolation at BEGIN, so a
    // nested request can neither strengthen the outer level nor prove it already
    // matches. Silently joining a default-READ-COMMITTED outer transaction would
    // hand back a snapshot weaker than requested and reintroduce the relink
    // undercount/double-count. Fail closed instead of lying about the guarantee.
    if (options?.isolationLevel) {
      throw new Error(
        `withDb.tx: cannot honor isolationLevel="${options.isolationLevel}" inside an ambient transaction — the outer transaction's isolation is fixed at BEGIN and may be weaker. Run this read as the outermost transaction, or open the ambient transaction at the required level.`
      );
    }
    return fn(tx);
  }

  const db = await getDatabase();
  return db.$transaction((tx) => als.run({ tx }, fn, tx), options);
};

// -----------------------------------------------------------------------------
// Internal implementation
// -----------------------------------------------------------------------------

const als = new AsyncLocalStorage<{ tx: TransactionClient }>();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | null;
  pool: pg.Pool | null;
};

/**
 * Gets or creates the Prisma Client.
 *
 * Uses global caching to reuse client across requests.
 */
async function getDatabase(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  // ISS-5984: strictly before the first query of a cold instance, and skipped
  // entirely once the client is cached above. No hook is registered by default,
  // and none is registered outside `apps/api` at all. See `setSchemaBootstrapHook`.
  if (schemaBootstrapHook) {
    await schemaBootstrapHook();
  }

  return createPrismaClient();
}

/**
 * The shared Prisma client, for libraries that need a client instance at
 * construction time rather than per call (the Better Auth adapter in apps/api).
 * Prefer `withDb` everywhere else: it joins an ambient `withDb.tx` transaction,
 * this does not. Skips the schema bootstrap hook, which self-hosted deployments
 * never register.
 */
export function getPrismaClient(): PrismaClient {
  return globalForPrisma.prisma ?? createPrismaClient();
}

function createPrismaClient(): PrismaClient {
  const pool = getPool();
  const schema = resolveSchemaName({
    pgSchema: keys().PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const adapter = new PrismaPg(pool, schema ? { schema } : undefined);
  globalForPrisma.prisma = new PrismaClient({ adapter });

  return globalForPrisma.prisma;
}

/**
 * Gets or creates the pg Pool from `DATABASE_URL`.
 * Cached globally to reuse connections.
 */
function getPool(): pg.Pool {
  if (globalForPrisma.pool) {
    return globalForPrisma.pool;
  }

  const env = keys();
  const schema = resolveSchemaName({
    pgSchema: env.PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const searchPath =
    schema && schema.length > 0 ? formatSearchPath(schema) : null;

  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Self-hosted deployments connect with a " +
        "standard PostgreSQL connection string (see docker-compose.yml)."
    );
  }

  // `max` stays at pg's default value but is passed explicitly (FEA-3315):
  // raising it marches the instance count toward the server's connection
  // ceiling. apps/api/lib/db-fanout.ts derives its fan-out bound from the same
  // constant.
  const url = new URL(env.DATABASE_URL);
  const isLocalhost = isLocalhostUrl(url);
  // Read sslmode before stripping it from the connection string — we provide
  // explicit ssl config to the Pool, and keeping sslmode on the URL too can
  // cause driver/adapter conflicts. Delegate to the shared SSL policy so the
  // runtime pool honors the caller's sslmode (e.g. `?sslmode=disable` opts
  // out of TLS) and defaults to verified TLS for non-localhost hosts, matching
  // the seed scripts. Verification trusts the system roots plus the bundled
  // RDS CA (`VERIFIED_SSL_CA`), so both publicly-trusted hosts (e.g. Neon) and
  // RDS endpoints verify. `ALLOW_INSECURE_SSL=1` is the deploy-free escape hatch
  // the seed scripts also honor — it restores unverified (but still encrypted)
  // TLS for any endpoint not covered by the bundle, preferable to the only
  // other URL-side opt-out (`?sslmode=disable`, which drops TLS).
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  globalForPrisma.pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: resolveSslOption({
      isLocalhost,
      sslmode,
      allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
    }),
    max: DB_POOL_MAX_DATABASE_URL_DEFAULT,
    // Without this, pg-pool queues an 11th concurrent caller with no timer at
    // all and it waits forever — no timeout, no error, nothing for a monitor
    // to see (FEA-3315).
    connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });

  // Instrument before the pool escapes this function, so no acquisition can
  // bypass telemetry. Emits nothing until a sink is registered (FEA-3300).
  return instrumentPool(globalForPrisma.pool);
}

/**
 * A hook run once per instance, immediately before the Prisma client is first
 * created — i.e. before the first query any consumer can issue.
 *
 * ISS-5984 needs this because a Vercel preview's schema is created lazily at
 * runtime rather than by the build: the runtime client only RESOLVES a schema
 * name and hands it to `PrismaPg`, so a schema that does not exist yet fails
 * every query. The hook is the seam where `apps/api` brings it to migration
 * head first.
 *
 * Injected rather than imported for the same reason as `setPoolTelemetrySink`:
 * the bootstrap lives in `apps/api`, which this package must not depend on.
 * Unregistered — the default, and the permanent state for `apps/mcp` and every
 * test — it costs one null check.
 */
export type SchemaBootstrapHook = () => Promise<void>;

let schemaBootstrapHook: SchemaBootstrapHook | null = null;

/**
 * Registers (or, with `null`, clears) the pre-client bootstrap hook. Rejecting
 * from the hook deliberately fails the caller's `withDb` rather than proceeding
 * against a schema that may not exist.
 */
export function setSchemaBootstrapHook(hook: SchemaBootstrapHook | null): void {
  schemaBootstrapHook = hook;
}
