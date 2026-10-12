import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Per-migration DDL guard for the Better Auth identity tables. Each assertion
// targets the specific statement that creates the index or constraint, so a
// regenerated migration that drops uniqueness or a cascade fails here.

const MIGRATION_DIR = "20261004043342_add_better_auth_tables";
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

const SQL_LINE_COMMENT = /^--.*$/gm;
const WHITESPACE = /\s+/g;
const CREATE_TABLE_NAME = /CREATE TABLE "([a-z_]+)"/;

const STATEMENTS = MIGRATION_SQL.replaceAll(SQL_LINE_COMMENT, "")
  .split(";")
  .map((statement) => statement.replaceAll(WHITESPACE, " ").trim())
  .filter(Boolean);

function statementFor(prefix: string): string {
  const statement = STATEMENTS.find((candidate) =>
    candidate.startsWith(prefix)
  );
  if (!statement) {
    throw new Error(`No statement starts with: ${prefix}`);
  }
  return statement;
}

const UNIQUE_INDEXES: ReadonlyArray<readonly [string, string, string]> = [
  ["auth_users_email_key", "auth_users", "email"],
  ["auth_sessions_token_key", "auth_sessions", "token"],
  ["auth_organizations_slug_key", "auth_organizations", "slug"],
];

const LOOKUP_INDEXES: ReadonlyArray<readonly [string, string, string]> = [
  ["auth_sessions_user_id_idx", "auth_sessions", "user_id"],
  ["auth_accounts_user_id_idx", "auth_accounts", "user_id"],
  ["auth_verifications_identifier_idx", "auth_verifications", "identifier"],
  ["auth_members_organization_id_idx", "auth_members", "organization_id"],
  ["auth_members_user_id_idx", "auth_members", "user_id"],
  [
    "auth_invitations_organization_id_idx",
    "auth_invitations",
    "organization_id",
  ],
  ["auth_invitations_email_idx", "auth_invitations", "email"],
];

const CASCADING_FOREIGN_KEYS: ReadonlyArray<
  readonly [string, string, string, string]
> = [
  ["auth_sessions", "auth_sessions_user_id_fkey", "user_id", "auth_users"],
  ["auth_accounts", "auth_accounts_user_id_fkey", "user_id", "auth_users"],
  [
    "auth_members",
    "auth_members_organization_id_fkey",
    "organization_id",
    "auth_organizations",
  ],
  ["auth_members", "auth_members_user_id_fkey", "user_id", "auth_users"],
  [
    "auth_invitations",
    "auth_invitations_organization_id_fkey",
    "organization_id",
    "auth_organizations",
  ],
  [
    "auth_invitations",
    "auth_invitations_inviter_id_fkey",
    "inviter_id",
    "auth_users",
  ],
];

describe("add_better_auth_tables migration", () => {
  it("creates exactly the eight identity tables", () => {
    const created = STATEMENTS.filter((s) => s.startsWith("CREATE TABLE")).map(
      (s) => CREATE_TABLE_NAME.exec(s)?.[1]
    );
    expect(created.sort()).toEqual([
      "auth_accounts",
      "auth_invitations",
      "auth_jwks",
      "auth_members",
      "auth_organizations",
      "auth_sessions",
      "auth_users",
      "auth_verifications",
    ]);
  });

  it.each(
    UNIQUE_INDEXES
  )("enforces uniqueness with %s", (name, table, column) => {
    expect(statementFor(`CREATE UNIQUE INDEX "${name}"`)).toBe(
      `CREATE UNIQUE INDEX "${name}" ON "${table}"("${column}")`
    );
  });

  it.each(
    LOOKUP_INDEXES
  )("indexes the lookup path %s", (name, table, column) => {
    expect(statementFor(`CREATE INDEX "${name}"`)).toBe(
      `CREATE INDEX "${name}" ON "${table}"("${column}")`
    );
  });

  it.each(
    CASCADING_FOREIGN_KEYS
  )("%s.%s cascades deletes from its parent", (table, constraint, column, parent) => {
    expect(
      statementFor(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}"`)
    ).toBe(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" FOREIGN KEY ("${column}") REFERENCES "${parent}"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
  });
});
