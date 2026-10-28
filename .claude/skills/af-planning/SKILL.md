---
name: af-planning
description: "How to write an af-delivery plan.md for the AgentFlow monorepo: context section, task-card format, grouping and the per-area rule checklist. Used by af-planner when writing or revising a plan."
---

# af-planning — writing plans a sonnet implementer can execute

A good card lets the implementer start editing after reading the card and the files it names. A
weak card ("update the service to support X") makes the implementer re-explore the monorepo, which
is exactly the cost this harness exists to avoid.

## plan.md layout

```markdown
# Plan: <title>

## Summary
<3–5 lines: what changes and why>

## Context
<Facts every card shares: relevant entities, existing helpers to reuse (path + symbol), the
data flow touched (hook → api route → service → db), conventions that apply. ≤ 40 lines.>

## Assumptions
- <decision taken without asking, and the alternative>

## Groups
- g1: T001 T002 — <area>  [sequential | parallel-safe]
- g2: T003 — <area>

## Tasks

- [ ] T001 <imperative title>
  - Files: `path/a.ts` (edit), `path/a.test.ts` (new)
  - Change: <what to write, with symbol names, signatures, enum consts, where in the file>
  - Reuse: <existing helper/type and its path — never re-define it>
  - Rules: <only the checklist items that apply to this card>
  - Accept: <observable outcome, test names/cases>
  - Check: `bash .claude/skills/af-quality-gates/scripts/verify.sh quick <RUN_DIR> T001`

## Revisions
```

## Sizing and grouping

- One card = one coherent edit a sonnet session can finish in one pass: roughly ≤ 4 files and one
  concern. Split schema change, service, route, hook and UI into separate cards.
- Order groups along the dependency chain: `packages/database` schema → `packages/api` shared types
  → `apps/api` services/routes → `apps/app` hooks/UI → `apps/desktop` gateway. A group must leave the
  repo type-checking.
- Mark a group `parallel-safe` only if its cards touch disjoint files and do not depend on each
  other's new exports.
- Put tests in the same card as the code they cover. New parser/utility modules in domain packages
  need unit tests.
- Schema changes: the card names the Prisma model/fields and says to follow
  `packages/database/CLAUDE.md`; generating/applying migrations is a separate card.

## Rule checklist by area

Copy only the applicable lines into a card's `Rules:`; cite the source doc so the implementer can
check it.

| Area | Rules (source: root `CLAUDE.md` unless noted) |
| --- | --- |
| `apps/app` | No `@repo/database`; data via `apps/api`. `<Link>` for navigation. No on-mount queries that are not needed for first paint. No `.catch()` toasts on `mutateAsync`. `globalThis` not `window`. `pnpm lint:fix` after React edits. |
| `apps/api` | Routes thin, logic in `app/<resource>/service.ts` exporting one named object (`apps/api/AGENTS.md`). `waitUntil()` from `@/lib/wait-until` for background work. Zod for shapes. No `S3Client`; `@repo/storage`. Secrets via `@/lib/secret-encryption`. |
| `apps/desktop` gateway | Operations only in `apps/desktop/src/server/operations/`; auth via `isAuthorizedGatewayRequest`. Never weaken `apps/app/proxy.ts` / `gateway-guard.ts`. |
| Types | One canonical place: shared → `packages/api/src/types/`, DB → Prisma generated, else co-located. Enum consts (`DocumentType.X`), const-object enums, `import type` only for type-only use. |
| Style | No nested ternaries, positive branch first, cognitive complexity < 15, `RegExp.exec`, `replaceAll`, top-level imports only, new symbols at file bottom, no barrel re-exports. |

Also read the `AGENTS.md` of each app/package you touch; add its relevant rules to `## Context`.

## Revising

- From `feedback.md` (user): apply the corrections, update `## Assumptions`, keep task IDs stable,
  add new tasks as the next free IDs.
- From `escalation-<task>.md` (implementer): fix only that card using the implementer's findings;
  verify the paths/symbols yourself before rewriting. Append `- <task>: <what changed>` to
  `## Revisions`.
