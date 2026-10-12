import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Per-migration DDL guard: workflow-managed HTTP connections (the built-in
// "HTTP request" trigger of a workflow) and the per-compute-target model
// provider. Additive only; the managed-connection link is unique (one HTTP
// endpoint per workflow) and cascades with the workflow.

const MIGRATION_DIR =
  "20261005150000_add_workflow_http_endpoints_and_model_providers";
const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    MIGRATION_DIR,
    "migration.sql"
  ),
  "utf8"
);

const SQL_COMMENT_RE = /--.*$/gm;
const DESTRUCTIVE_RE = /DROP\s+(TABLE|COLUMN|INDEX)/i;
const CREATE_TABLE_RE = /CREATE\s+TABLE/i;
const COMPUTE_TARGETS_ALTER_RE = /ALTER TABLE "compute_targets"/;
const MODEL_PROVIDER_COLUMN_RE = /ADD COLUMN\s+"model_provider" JSONB(,|$)/;
const MODEL_PROVIDER_TOKEN_COLUMN_RE =
  /ADD COLUMN\s+"model_provider_token_encrypted" TEXT$/;
const NOT_NULL_OR_DEFAULT_RE = /NOT NULL|DEFAULT/;
const CONNECTIONS_ADD_COLUMN_RE =
  /ALTER TABLE "integration_connections" ADD COLUMN/;
const MANAGED_COLUMN_RE = /ADD COLUMN\s+"managed_by_workflow_id" UUID$/;
const UNIQUE_INDEX_RE = /CREATE UNIQUE INDEX/;
const ADD_CONSTRAINT_RE = /ADD CONSTRAINT/;

const STATEMENTS = MIGRATION_SQL.split(";")
  .map((statement) => statement.replaceAll(SQL_COMMENT_RE, "").trim())
  .filter(Boolean);

function statementsMatching(pattern: RegExp): string[] {
  return STATEMENTS.filter((statement) => pattern.test(statement));
}

describe(`${MIGRATION_DIR} DDL contract`, () => {
  it("is additive", () => {
    expect(MIGRATION_SQL).not.toMatch(DESTRUCTIVE_RE);
    expect(MIGRATION_SQL).not.toMatch(CREATE_TABLE_RE);
  });

  it("adds nullable model provider columns to compute_targets", () => {
    const [statement, ...others] = statementsMatching(COMPUTE_TARGETS_ALTER_RE);
    expect(others).toEqual([]);
    expect(statement).toMatch(MODEL_PROVIDER_COLUMN_RE);
    expect(statement).toMatch(MODEL_PROVIDER_TOKEN_COLUMN_RE);
    expect(statement).not.toMatch(NOT_NULL_OR_DEFAULT_RE);
  });

  it("links a connection to at most one workflow, cascading with it", () => {
    expect(statementsMatching(CONNECTIONS_ADD_COLUMN_RE)).toEqual([
      expect.stringMatching(MANAGED_COLUMN_RE),
    ]);
    expect(statementsMatching(UNIQUE_INDEX_RE)).toEqual([
      'CREATE UNIQUE INDEX "integration_connections_managed_by_workflow_id_key" ON "integration_connections"("managed_by_workflow_id")',
    ]);
    const [foreignKey, ...others] = statementsMatching(ADD_CONSTRAINT_RE);
    expect(others).toEqual([]);
    expect(foreignKey).toContain(
      'FOREIGN KEY ("managed_by_workflow_id") REFERENCES "workflows"("id")'
    );
    expect(foreignKey).toContain("ON DELETE CASCADE");
  });
});
