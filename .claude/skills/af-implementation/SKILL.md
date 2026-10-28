---
name: af-implementation
description: "How af-implementer executes af-delivery task cards in the AgentFlow monorepo: read budget, scope discipline, check commands, fixing verify/review findings and escalation. Used by af-implementer."
---

# af-implementation — executing task cards

## Read budget

The planner already explored. Your job is to edit, not to rediscover.

1. Read `plan.md` `## Context` and your cards only (use Grep on `plan.md` for `- [ ] T00N` if the
   plan is long).
2. Read the files listed under `Files:`. For large files, Grep the symbol named in `Change:` and
   Read that region.
3. Open other files only to confirm a symbol the card references under `Reuse:`.

If you find yourself reading more than ~6 files beyond the card's list, the card is underspecified:
escalate (see the agent definition) instead of continuing to explore.

## Editing

- Prefer Edit over Write for existing files.
- Follow the card's `Rules:` and the root `CLAUDE.md` code style; the plan does not repeat every
  style rule, and Biome will catch the formatting ones.
- After editing React components or many TS files in one package, run
  `npx biome check --write <changed files>` (add `--unsafe` only for `useBlockStatements`).
- Do not touch files outside the card except for mechanical follow-ups (imports, a fixture, a
  generated type path). List those in your reply.
- Never edit `apps/app/proxy.ts`, `apps/app/lib/engineer/gateway-guard.ts` or auth code unless the
  card explicitly says so.

## Checks

Run the card's `Check:` line. It uses
`.claude/skills/af-quality-gates/scripts/verify.sh quick <RUN_DIR> <label>`, which lints the
changed files, type-checks the affected packages and runs related tests, printing only a summary.
Read `RUN_DIR/logs/<label>-*.log` only for the gate that failed, and only the lines you need.

## Fixing findings

When given `verify-<group>.md` or `review.md`: fix exactly the listed findings, rerun the check,
and reply with which findings are fixed. If a finding is wrong (the code is correct), say so with a
one-line reason instead of changing the code.

## Finishing a card

Mark it `- [x]` in `plan.md`. Do not stage, commit or push.
