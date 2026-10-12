import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Per-migration DDL guard: a project's configurable process (append-only
// versions) and the step progress of a workflow run. Additive only: existing
// runs keep their status and get null step columns (the built-in flow).

const MIGRATION_DIR = "20261006092253_add_project_processes";
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
const WHITESPACE_RE = /\s+/g;
const DESTRUCTIVE_RE = /DROP\s+(TABLE|COLUMN|INDEX)|UPDATE\s+"|DELETE\s+FROM/i;
const RUNS_ALTER_RE = /ALTER TABLE "workflow_runs" ADD COLUMN/;
const RUN_LOOPS_ALTER_RE = /ALTER TABLE "workflow_run_loops" ADD COLUMN/;
const NOT_NULL_OR_DEFAULT_RE = /NOT NULL|DEFAULT/;
const UNIQUE_INDEX_RE = /CREATE UNIQUE INDEX/;
const ADD_CONSTRAINT_RE = /ADD CONSTRAINT .* FOREIGN KEY/;
const CREATE_TABLE_RE = /CREATE TABLE "project_process_versions"/;

const STATEMENTS = MIGRATION_SQL.split(";")
  .map((statement) =>
    statement
      .replaceAll(SQL_COMMENT_RE, "")
      .replaceAll(WHITESPACE_RE, " ")
      .trim()
  )
  .filter(Boolean);

function statementsMatching(pattern: RegExp): string[] {
  return STATEMENTS.filter((statement) => pattern.test(statement));
}

describe(`${MIGRATION_DIR} DDL contract`, () => {
  it("is additive and leaves existing rows alone", () => {
    expect(MIGRATION_SQL).not.toMatch(DESTRUCTIVE_RE);
  });

  it("adds nullable process and step columns to workflow runs and their loops", () => {
    const [runs, ...otherRuns] = statementsMatching(RUNS_ALTER_RE);
    expect(otherRuns).toEqual([]);
    expect(runs).toContain('ADD COLUMN "process" JSONB');
    expect(runs).toContain('ADD COLUMN "step_id" VARCHAR(64)');
    expect(runs).toContain('ADD COLUMN "step_state" JSONB');
    expect(runs).not.toMatch(NOT_NULL_OR_DEFAULT_RE);

    const [loops, ...otherLoops] = statementsMatching(RUN_LOOPS_ALTER_RE);
    expect(otherLoops).toEqual([]);
    expect(loops?.replaceAll(/\s+/g, " ")).toBe(
      'ALTER TABLE "workflow_run_loops" ADD COLUMN "step_id" VARCHAR(64)'
    );
  });

  it("keeps one row per project and version, removed with the project", () => {
    expect(statementsMatching(CREATE_TABLE_RE)).toHaveLength(1);
    expect(statementsMatching(UNIQUE_INDEX_RE)).toEqual([
      'CREATE UNIQUE INDEX "project_process_versions_project_id_version_key" ON "project_process_versions"("project_id", "version")',
    ]);
    const foreignKeys = statementsMatching(ADD_CONSTRAINT_RE);
    expect(foreignKeys).toHaveLength(3);
    const byColumn = (column: string) =>
      foreignKeys.find((statement) =>
        statement.includes(`FOREIGN KEY ("${column}")`)
      );
    expect(byColumn("project_id")).toContain(
      'REFERENCES "projects"("id") ON DELETE CASCADE'
    );
    expect(byColumn("organization_id")).toContain(
      'REFERENCES "organizations"("id") ON DELETE CASCADE'
    );
    expect(byColumn("created_by_id")).toContain(
      'REFERENCES "users"("id") ON DELETE SET NULL'
    );
  });
});
