// Seeds missing local env files from their .env.example templates before `pnpm dev`.
// Written in Node (not shell) so it behaves the same on Windows, macOS and Linux.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const envFiles = [
  ["apps/app/.env.example", "apps/app/.env.local"],
  ["apps/api/.env.example", "apps/api/.env.local"],
  ["apps/web/.env.example", "apps/web/.env.local"],
  ["apps/mcp/.env.example", "apps/mcp/.env.local"],
  ["apps/relay/.env.example", "apps/relay/.env.local"],
  ["packages/database/.env.example", "packages/database/.env"],
];

for (const [example, target] of envFiles) {
  const from = path.join(root, example);
  const to = path.join(root, target);
  if (!existsSync(to) && existsSync(from)) {
    copyFileSync(from, to);
  }
}
