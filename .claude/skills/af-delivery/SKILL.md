---
name: af-delivery
description: "Orchestrates a feature, bug fix or refactor in the AgentFlow monorepo with a mixed-model agent team: af-planner (opus) writes a task-card plan, af-implementer (sonnet) executes it, af-verifier (haiku) runs lint/type/test gates, af-reviewer (opus) does the final review. Use for any multi-file code change in this repo ('implement', 'add feature', 'fix bug', 'refactor', 'build this PRD'), and for follow-ups on a previous run ('re-run', 'continue', 'fix the review findings', 'only redo T004', 'revise the plan'). Not for questions, one-line edits, or docs-only changes — handle those directly."
---

# af-delivery — plan with opus, execute with sonnet, verify with haiku

The token saving comes from three rules. Keep them even when a shortcut looks faster:

1. **The expensive models think once.** `af-planner` (opus) does the exploration and design and
   writes it down as task cards. `af-reviewer` (opus) sees only the final diff.
2. **The cheap models do the volume.** `af-implementer` (sonnet) edits code from cards without
   re-exploring; `af-verifier` (haiku) absorbs long lint/type/test logs.
3. **The orchestrator (this session) carries file paths, not content.** Do not read source files,
   diffs or logs yourself; read `plan.md`, `verify-*.md`, `review.md` only when a decision needs it.
   Agent replies are capped at a few lines for the same reason.

The orchestrator can run on any model. For the cheapest setup, run this session on sonnet
(`/model sonnet`); each agent pins its own model in `.claude/agents/af-*.md`.

**Execution mode:** sub-agent delegation (`Agent` with `subagent_type`) for every phase. Agents
never talk to each other; they hand off through files in `RUN_DIR`.

## Phase 0 — run context

1. Derive a short kebab-case `slug` from the request (or the ticket key, e.g. `pln-123`).
   `RUN_DIR=.harness/runs/<slug>/` (git-ignored).
2. Pick the path:
   - `RUN_DIR` does not exist → new run: create it and write the request verbatim (plus any linked
     PRD/issue text the user gave) to `RUN_DIR/00_request.md`.
   - It exists and the user asks for a partial redo ("fix review findings", "only T004", "revise the
     plan") → jump to the matching phase; reuse `plan.md` and the reports.
   - It exists and the user gives a new request under the same slug → move it to
     `.harness/runs/<slug>-prev-<n>/` and start fresh.
3. Run `bash .claude/skills/af-quality-gates/scripts/verify.sh baseline <RUN_DIR>` (new runs only).
   It records already-dirty files with their hashes so the gates check only the run's own changes.

## Phase 1 — plan (opus)

Call `Agent(subagent_type: "af-planner")` with `RUN_DIR` and the instruction "write plan.md".
Then read `RUN_DIR/plan.md` `## Summary`, `## Groups`, `## Assumptions` (not the cards).

If the plan has `## Blocked`, report it to the user and stop.

## Phase 2 — approval gate

Show the user, in a few lines: the summary, the groups with task IDs, the assumptions and the risky
areas. Ask them to approve or correct. On corrections, write them to `RUN_DIR/feedback.md` and call
`af-planner` again to revise ("revise plan.md per feedback.md"). Skip this gate only if the user
said up front to run unattended; then log the assumptions in the final report.

## Phase 3 — execute groups (sonnet + haiku)

For each group in `## Groups`, in order:

1. `Agent(subagent_type: "af-implementer")` with `RUN_DIR` and the group's task IDs.
   - Groups the plan marks `parallel-safe` (disjoint files) may be dispatched in one message as
     separate implementer calls. Otherwise run groups sequentially — they share one working tree.
2. If the reply contains `escalate`: call `af-planner` with "revise the card(s) per
   escalation-<task>.md", then rerun the implementer for those tasks only. At most one escalation
   round per task; after that, stop and report to the user.
3. `Agent(subagent_type: "af-verifier")` with `RUN_DIR`, group name `g<N>`, mode `quick`.
4. On `fail` (code failures, not environment): rerun `af-implementer` with the same tasks plus
   "fix the failures in verify-g<N>.md", then verify again. At most **2** fix rounds per group;
   then escalate to `af-planner` as in step 2.
5. Environment failures (no `node_modules`, DB down): stop and tell the user what to start; do
   not let agents try to fix the environment.

## Phase 4 — final gate (haiku + opus)

1. `af-verifier` with group `final`, mode `full`.
2. `Agent(subagent_type: "af-reviewer")` with `RUN_DIR`.
3. `Verdict: changes` with `blocker`/`major` findings → `af-implementer` with "fix review.md
   findings" (pass the finding lines' task IDs if any), then `af-verifier` `final` again. One review
   fix round; then rerun `af-reviewer` once. `minor` findings go into the report, not a fix round.

## Phase 5 — report

Tell the user (Vietnamese if they wrote in Vietnamese): what changed (files by area), the gate
results, open minor findings, assumptions taken, and `RUN_DIR`. Do not commit or push unless the
user asks; then follow the repo's conventional-commit rule.

## Error handling

- An agent that fails or returns nothing: retry once with the same input. A second failure → stop
  and report which phase and what partial files exist in `RUN_DIR`.
- Usage limit, auth expiry or permission denial: do not retry; report and stop.
- Never fill in an agent's missing output from guesses. Only facts you verified go into the report.

## Model override

If the user asks for a different cost/quality trade-off for one run, pass `model` on the `Agent`
call (e.g. `fable` for the planner on a very large cross-repo PRD, `haiku` for a trivial
implementer task). Do not edit the agent files for a one-off.
