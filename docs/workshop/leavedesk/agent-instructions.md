# LeaveDesk

Leave management for Sao Mai Software (about 120 people, Hanoi and Ho Chi Minh
City): employees request leave, managers approve it, HR runs the leave policy.
Requirements come from the Jira project **LD**; three workflows deliver them,
one Jira bot each: BA analysis (label `ba-analyze`) → Dev implementation
(`ready-for-dev`) → QC testing (`ready-for-qc`).

## Repositories (all in this workspace)

| Folder | What it is | Who changes it |
|---|---|---|
| `leavedesk-app/` | The app: Node.js 24, Express 5 + `node:sqlite`, React 19 + Vite, Vitest. Read its README and CLAUDE.md. | Dev workflow only |
| `leavedesk-knowledge/` | Knowledge base: leave policy (source of truth), decisions, change requests, meetings, system docs, one folder per requirement; the BA agent team in `.claude/`. | BA workflow only |
| `leavedesk-superpowers/` | Dev toolkit: obra/superpowers skills, plus spec, plan and report per ticket in `work/<KEY>/`. | Dev workflow only |
| `leavedesk-qa/` | Test cases, Playwright specs and results per ticket; the QC agent team in `.claude/`. | QC workflow only |

Each workflow changes only its own repositories: a repository with changes gets
a pull request, so stray edits (a lockfile, a build output) become noise in
review.

## Domain rules everyone follows

- The policy `leavedesk-knowledge/policies/leave-policy-v3.1.md` is the source of
  truth; decisions in `leavedesk-knowledge/decisions/` are binding (e.g. D-003:
  balances come from a ledger, never a stored number).
- Dates are ISO `YYYY-MM-DD` in Asia/Ho_Chi_Minh; working days are Monday to
  Friday minus public holidays; half a day is the smallest unit.
- "Today" in the app is `today()` (`LEAVEDESK_TODAY` pins it); examples in PRDs
  and tests use 2026-10-19 unless they say otherwise.
- Demo accounts (password `Password123!`) are in `leavedesk-app/README.md`.

## Writing back to Jira

Comments are short and concrete: what was done, what is needed from whom, links.
Never paste secrets or the content of `.agentflow-ai/` files other than the ones
a step names.
