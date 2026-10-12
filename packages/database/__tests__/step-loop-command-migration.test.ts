import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Per-migration DDL guard: STEP loops run one step of a project process. The
// migration only adds the enum value; existing loops keep their command.

const MIGRATION_DIR = "20261006095025_add_step_loop_command";
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

const STATEMENTS = MIGRATION_SQL.split(";")
  .map((statement) =>
    statement
      .replaceAll(SQL_COMMENT_RE, "")
      .replaceAll(WHITESPACE_RE, " ")
      .trim()
  )
  .filter(Boolean);

describe("add_step_loop_command migration", () => {
  it("only adds STEP to the LoopCommand enum", () => {
    expect(STATEMENTS).toEqual([`ALTER TYPE "LoopCommand" ADD VALUE 'STEP'`]);
  });
});
