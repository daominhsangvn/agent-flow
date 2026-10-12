// Prints the tables Better Auth expects for this deployment's plugin set, so the
// Prisma models in packages/database/prisma/schema.prisma can be kept in sync
// after a Better Auth upgrade or a plugin change.
//
//   node apps/api/scripts/print-better-auth-tables.mjs
import { getAuthTables } from "better-auth/db";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

const tables = getAuthTables({
  plugins: [organization(), jwt()],
});

for (const [key, table] of Object.entries(tables)) {
  console.log(`\n# ${key} -> modelName "${table.modelName}"`);
  for (const [field, def] of Object.entries(table.fields)) {
    const flags = [
      def.required === false ? "optional" : "required",
      def.unique ? "unique" : "",
      def.references
        ? `ref ${def.references.model}.${def.references.field} onDelete=${def.references.onDelete ?? "-"}`
        : "",
      def.defaultValue === undefined ? "" : "default",
      def.index ? "index" : "",
    ].filter(Boolean);
    console.log(
      `  ${field.padEnd(22)} ${String(def.type).padEnd(10)} ${flags.join(", ")}`
    );
  }
}
