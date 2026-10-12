import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the e2e helpers (not Playwright specs). Run from the repo
 * root: `npx vitest run --config e2e/vitest.config.ts`.
 */
export default defineConfig({
  // Keep Vite's cache in the root node_modules instead of creating e2e/node_modules.
  cacheDir: path.resolve(
    import.meta.dirname,
    "..",
    "node_modules",
    ".vite",
    "e2e"
  ),
  resolve: {
    // Same mapping as the root tsconfig paths the Playwright loader uses.
    alias: [
      {
        find: /^@repo\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "..", "packages", "$1"),
      },
    ],
  },
  test: {
    root: import.meta.dirname,
    include: ["helpers/__tests__/**/*.test.ts"],
  },
});
