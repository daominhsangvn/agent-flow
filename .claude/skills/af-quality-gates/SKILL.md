---
name: af-quality-gates
description: "Lint/typecheck/test gates for af-delivery runs in the AgentFlow monorepo, scoped to the packages a change touches, with logs kept on disk and only a summary printed. Used by af-verifier and af-implementer; run scripts/verify.sh rather than hand-written turbo commands."
---

# af-quality-gates

- `scripts/verify.sh baseline <RUN_DIR>` — phase 0, once per run.
- `scripts/verify.sh <quick|full> <RUN_DIR> <label>` — the gates.

Changed files = `git diff --name-only HEAD` plus untracked files, minus paths whose content hash is
unchanged since `RUN_DIR/01_baseline.txt` (changes that existed before the run). Each changed file maps to its
workspace (`apps/<x>` or `packages/<x>`); the workspace's `package.json` name is the turbo filter.

| Gate | quick | full |
| --- | --- | --- |
| lint | `npx biome check` on changed files | same |
| typecheck | `pnpm turbo typecheck --filter=<pkg>` per affected workspace | `--filter=...<pkg>` (dependents too) |
| test | `vitest related --run <changed files>` per affected vitest workspace | `pnpm turbo test --filter=<pkg>` |

Notes:

- `apps/desktop` quick mode: `vitest related` with `vitest.renderer.config.ts` for
  `src/renderer/**`; changed main-process `*.test.ts` files run with `tsx --test` (the Vitest node
  lane is broken locally). Full mode runs `pnpm desktop:test`. When the card changes desktop source
  without tests, its `Check:` should name the existing test files to run.
- The script switches to the `.nvmrc` Node via nvm when `pnpm` is not on PATH.
- Prisma schema changes require `pnpm --filter @repo/database db:generate` before typecheck; the
  script runs it when `schema.prisma` is among the changed files.
- Full logs: `RUN_DIR/logs/<label>-<gate>-<pkg>.log`. The script prints one line per gate and the
  last 40 lines of each failing log.
- Exit code: 0 all pass, 1 any code failure, 2 environment problem (no `node_modules`, pnpm
  missing).
