# Plan: step roles, review loops, pull request feedback and Confluence

Status: Parts 1–6 implemented, Part 7 later · 2026-10-15

| Part | What | Size | Depends on |
|---|---|---|---|
| 1. Step roles | Done (2026-10-15, not committed). `role: plan / implement` on agent steps: AgentFlow appends the plan/implement contract, requires the plan file, versions the run's plan, loads the approved plan, writes release notes. Differences: no runner capability gate (runners build from this repo; an older runner still gets the repair prompt naming the file); template variables are `{{releaseNotes}}` / `{{releaseNotes.url}}`. | M | — |
| 2. Release notes for `agentflow.execute` | Done (2026-10-15, not committed). The built-in implement step writes release notes too; publishing them is best effort (logged, the run goes on). | S | 1 |
| 3. Review loops | Done (2026-10-15, not committed): `review:` on agent steps (approve / complete / feedback by app, label, mention), label approval on `approval` steps, feedback rounds that resume the step, pending signals, label consumption, `POST /workflow-runs/{id}/review`, run page review panel (always on, no flag). Differences: a feedback's text is read from the item's comments when its round starts (not at ingest); signals reach the waiting step or, while a run works, its current or next step. | L | 1 |
| 4. Source labels and links | Done (2026-10-15, not committed): `jira.update_labels`, `jira.add_link`, `azure_devops.update_tags`, `azure_devops.add_link`, `source: [label, link]` grants and tools, `SourceItem.links` (Jira remote links, ADO Hyperlinks) in the Issue body. Consuming review labels comes with Part 3. | S–M | — (3 uses it) |
| 5. Pull request review tools | Done: provider-neutral tools to read, reply to and resolve pull request comments (Bitbucket Cloud and Azure DevOps), shipped as `pull_requests_list`, `pull_request_threads`, `pull_request_reply`, `pull_request_resolve` (see Part 5 status below). | M | 3 |
| 6. Confluence | Done: `confluence` provider: read pages and comments, optional page and comment writes (differences in Part 6 status below). | M–L | — |
| 7. Later | Pull request webhooks (Bitbucket, Azure DevOps): feedback from the pull request itself | M | 5 |

## Goal

Let a project run the delivery flow its developers already follow by hand, with its own toolkit,
through a ticket:

1. A BA writes the PRD in a Jira (or Azure DevOps) ticket and labels it (or assigns it to the bot).
2. **Plan** with the project's own planning command or skill (Spec Kit or custom, from the toolkit
   repository). AgentFlow guarantees the plan ends up in the run's Implementation Plan.
3. **Review the plan**: reviewers read it (in AgentFlow, or on a Confluence page the developer
   copies it to, or the agent writes it to), comment, and the developer asks the bot to replan
   (`@bot <what to change>`, a label, or Replan in AgentFlow). The step resumes its session with the
   feedback, reads the Confluence comments if the ticket links a plan page, and writes a new plan
   version. Repeat until approved (label, or Approve in AgentFlow).
4. **Implement** with the project's own command: AgentFlow loads the approved plan, pushes every
   changed repository, opens one pull request per repository and writes release notes.
5. **Code review**: reviewers comment on the pull requests; the developer asks the bot to address
   them (`@bot fix the review comments`, a label, or in AgentFlow). The step resumes, reads the
   pull request comments (Bitbucket or Azure DevOps), fixes, replies, resolves and pushes to the
   same branch, so the pull requests update. Done when the ticket gets the done label (or Done in
   AgentFlow, for runs without a ticket system); pull request states are not used.

AgentFlow provides capabilities and guarantees (contracts, tools, grants, run control). How a
project plans, which Confluence page it uses and how it treats comments stays in the project's
instructions.

## Today

Facts this plan builds on (all verified in the code on 2026-10-15):

- Process steps: `packages/api/src/types/project-process.ts`. Agent steps (`type: agent`) run a
  STEP loop with `instruction`, `questions`, `artifacts`, `reply`, `document`, `finish`,
  `connections`. `agentflow.plan` / `agentflow.execute` run the built-in PLAN / EXECUTE loops.
  `approval` moves the run to `needs_approval`; a rejection fails the run (`approval_rejected`).
- Toolkit: `toolkit.mounts` are symlinked from the toolkit repository into the workspace root
  (`apps/desktop/src/server/operations/loop-step.ts` `mountToolkit` / `linkInto`). Claude Code always
  starts at the workspace root. A mount whose target already exists (the root `CLAUDE.md`, an
  existing `.claude/`) is merged entry by entry or skipped.
- The workspace `CLAUDE.md` holds the project instructions and the repository table
  (`loop-workspace.ts`) plus the step section (`buildStepWorkspaceInstructions`: unattended, issue
  file, questions contract, commit rule, toolkit instructions). Nothing tells the agent where to
  write its outputs (`reply`, `document`): the engine only reads them afterwards.
- A step "finishes" when its STEP loop completes (Claude exits). `settleAgentStep`
  (`engine/agent-step.ts`) then reads `questions.json` (→ `needs_input`), publishes the step's
  `document` (`engine/step-documents.ts`, a separate document linked from the Issue) and moves on. A
  missing output file is silently ignored.
- `ensureRunDocuments` creates the run's plan document only when the process has an
  `agentflow.plan` step (`withPlanDocument`).
- Resuming a step's session is in place for answers and question repairs
  (`engine/agent-step-resume.ts`: `launchStepLoop` with `resumeLoopId`, same computer and workspace).
- Ingest (`engine/ingest.ts` `decideRunLocked`): an event that matches a trigger resumes an active
  run only when it is `needs_input`; every other active run ignores it.
- Jira/Azure DevOps `*_conditions` events carry `addedLabels` / `addedTags`, `mentioned`, the
  labels/tags after the change; the comment id is only in the dedup key.
- Jira actions: `add_comment`, `transition_issue`. Azure DevOps: `add_comment`, `update_state`,
  `create_pull_request`, `run_pipeline`. No label/tag or link operations.
- Repository providers expose `createPullRequest` only (`IntegrationRepositoriesDefinition` in
  `apps/api/lib/integrations/types.ts`). Bitbucket has no inbound side (`triggers: []`).
- Agent tools (`apps/api/lib/integrations/agent-tools/catalog.ts`): `integrations_overview`,
  `source_item_get`, `source_item_comment`, `source_item_transition`, `connection_get_item`, and one
  tool per granted external **write** operation. There are no provider read operations besides
  reading items. Step write budget: `PROCESS_STEP_TOOL_WRITES_MAX = 20`.
- Release notes are not an AgentFlow concept: DOC-5 ("Release notes: CALC-6 …") was published by a
  `release-notes` agent step configured for the Calculator workshop (`PRODUCES` link metadata
  `stepId: release-notes`).
- No Confluence integration exists.

## Decisions

| Topic | Decision |
|---|---|
| Who decides the flow | Project instructions decide how to plan, what to read, which page to use. AgentFlow provides the contracts (where outputs go), the tools, the grants and the run control (wait, approve, feedback). |
| Step roles | An agent step may declare `role: plan` or `role: implement`. The role makes AgentFlow append its contract to the step's `CLAUDE.md` section and handle the outputs. A step without a role behaves as today. |
| Plan output | Fixed path `.agentflow-ai/work/plan.md`, whatever the toolkit writes elsewhere. Required: a missing plan resumes the session once to write it, then fails the step. It becomes a new version of the run's Implementation Plan (the same document `agentflow.plan` uses). |
| Implement input | The approved plan version is written to `.agentflow-ai/work/plan.md` before an implement step starts (and before every feedback round), so a plan edited in AgentFlow wins over the file on disk. |
| Release notes | Default for implement steps (`role: implement` and `agentflow.execute`), `releaseNotes: false` turns it off. Written to `.agentflow-ai/work/release-notes.md`, published as one DOC per run (versions per round), exposed as `{{releaseNotes}}` and `{{releaseNotes.url}}`. |
| Review | A `review:` block on an agent step. After the step ends the run waits (`needs_approval`) for **approve** (next step, or the run succeeds) or **feedback** (the same step runs again with the feedback, then waits again). Reject in AgentFlow fails the run as today. |
| Signals | Go on: `approve` on a plan step, `complete` on any other reviewed step (the implement step: code review is over). Both are an AgentFlow button (**Approve** / **Done**) or labels/tags added on the source item; the button also serves runs without a ticket system. Pull request states are never a signal. Feedback: AgentFlow button (**Replan** on a plan step, **Request changes** on any other step), a comment that mentions the bot (its text is the feedback), labels/tags added. Configured per step, so per workflow (its own process) or per project. |
| Signal routing | Signals reach the run waiting on that source item, independently of the workflow's triggers, so the trigger can stay "label added" or "assigned to the bot" and a signal never starts a new run. Signals that arrive while the step still works are queued and applied when it starts waiting. |
| Label consumption | A feedback label is removed from the source item once applied (so it can be added again). This is the one source write the engine does on its own; `consumeLabels: false` turns it off. Approve labels are kept. |
| Review wait | Never expires: the run waits until a signal arrives or someone cancels it (the phase timeout applies only to the step's own loops). |
| Feedback session | Resume the step's session (`--resume`) with the feedback by default; `review.session: fresh` starts a new session with the instruction and the feedback (the plan and code on disk carry the context). |
| Who decides | Approve, Done and Reject in AgentFlow: org admins (as approvals today). Feedback in AgentFlow: any member. On the ticket: anyone who can label or comment (accepted by the product owner). |
| Pull request tools | Provider-neutral, pinned to the run's pull requests (like `source_*` tools are pinned to the run's item), granted with a reserved `pull_requests` key. Implemented for Bitbucket Cloud and Azure DevOps; GitHub and Local Git answer "not supported" until implemented. |
| Confluence | A provider with no triggers: reads (page, page search, comments) and writes (create/update page, comment/reply, resolve) as tools, restricted to the project connection's spaces. Plans stay in AgentFlow by default; a project grants page writes only if it wants the agent to publish. |
| Provider reads | New provider-declared read operations (`reads`), offered as tools on `read` grants. Confluence is the first user. |
| Write budget | Step writes per loop: 20 → 100 (resolving and replying to many comments). |
| Runner versions | Role-aware runners report a capability; the engine refuses to launch a role step on an older runner with a clear error instead of silently missing outputs. |

## Target configuration

Simple flow (built-in planner, label approval, PR on Bitbucket):

```yaml
# Project process
steps:
  - type: agentflow.plan
    id: plan
    name: Plan
    questions: ask
    recommendations: suggest
  - type: approval
    id: approve-plan
    name: Approve the plan
    approve: { labels: [plan-approved] }          # new; Approve in AgentFlow still works
  - type: agentflow.execute
    id: implement
    name: Implement
    # releaseNotes: true (default, new)

# Workflow
triggers:
  - connection: jira
    type: jira.issue_conditions
    config: { match: all, assigned: true, labels: [planning-ready], projectKeys: [PROJ] }
actions:
  - on: workflow.triggered
    type: jira.update_labels                      # new
    config: { remove: [planning-ready] }
  - on: plan.completed
    type: jira.add_comment
  - on: input.needed                              # questions, or waiting for the approval
    type: jira.add_comment
  - on: execute.completed
    type: bitbucket.create_pull_request
  - on: execute.completed
    type: jira.add_comment
    config:
      message: "Pull requests:\n{{pr.urls}}\n\nRelease notes\n{{releaseNotes}}"   # new variable
```

Full flow (own toolkit, review loops, Confluence context, pull request feedback):

```yaml
toolkit:
  repository: team/agent-repo
  mounts: [.claude, .specify, specs]
  instructions: "@agent-repo/CLAUDE.md"
steps:
  - type: agent
    id: plan
    name: Plan
    role: plan                                    # new
    instruction: |
      Use the plan-ticket skill for {{issue.key}} ({{issue.file}}).
      If the ticket links the Confluence page of the plan, read it and its open comments.
    questions: ask
    review:                                       # new
      approve:  { labels: [plan-approved] }
      feedback: { mention: true, labels: [replan] }
      instruction: |
        Replan: {{feedback.text}}
        Read the open comments of the plan's Confluence page (link in the ticket), apply them,
        reply to and resolve each one you handled.
    connections:
      source: [comment]
      confluence: [confluence.comment, confluence.resolve_comment]   # new provider; reads implied

  - type: agent
    id: implement
    name: Implement
    role: implement                               # new: finish push, approved plan, release notes
    instruction: Use the implement-ticket skill to implement the approved plan.
    review:
      complete: { labels: [done] }                # code review over; Done in AgentFlow too
      feedback: { mention: true, labels: [fix-review] }
      instruction: |
        Address the code review: {{feedback.text}}
        Read the open threads of the run's pull requests, fix the code, reply to and resolve each
        thread you handled.
    connections:
      source: [comment]
      pull_requests: [reply, resolve]             # new reserved key
```

## Part 1 — Step roles

### Schema (`packages/api/src/types/project-process.ts`)

- `ProcessStepRole = { Plan: "plan", Implement: "implement" } as const` and an optional `role` on
  `agentStepSchema`.
- `releaseNotes: z.boolean().default(true)` on `agentStepSchema` (only meaningful with
  `role: implement`) and on `agentFlowExecuteStepSchema`.
- `projectProcessSchema.superRefine` additions:
  - at most one plan producer (`agentflow.plan` or `role: plan`);
  - `role: implement` needs a plan producer before it; `agentflow.execute` keeps its rule (needs
    `agentflow.plan`, because EXECUTE continues the PLAN loop's state);
  - `role: implement` implies `finish: push` (default it in a transform; `finish: none` is an error);
  - `role: plan` with `document.type: IMPLEMENTATION_PLAN` is an error (the role already owns it).
- `PROCESS_INSTRUCTION_VARIABLES`: nothing new for roles.

### Loop contract (`packages/loops-api/src/loop-step.ts`)

- `LoopStepConfigSchema` gains `role?: "plan" | "implement"` and `releaseNotes?: boolean`.
- `LoopStepFile` gains `Plan: "plan.md"` and `ReleaseNotes: "release-notes.md"`.
- Runner capability `stepRoles` (reported like `toolchains`); `launchStepLoop` refuses a role step on
  a runner without it (`step_failed`, "update the runner").

### Runner (`apps/desktop/src/server/operations/loop-step.ts`)

- `buildStepWorkspaceInstructions` appends the role contract:
  - plan: "When the plan is final, write it to `.agentflow-ai/work/plan.md`, also when your tools wrote
    it elsewhere (copy it). AgentFlow shows it as the run's Implementation Plan." Plus the expected
    shape (summary, per-repository changes, ordered tasks as `- [ ]` items, risks, open questions)
    once confirmed against what the plan view, Evaluate Plan and the implement steps read (see
    "To verify"). "Questions go to `questions.json`, never in chat."
  - implement: "The approved plan is `.agentflow-ai/work/plan.md`: implement it. When done, write
    release notes to `.agentflow-ai/work/release-notes.md`" (format: what changed for users, per
    repository, notable risks; no file lists), only when `releaseNotes`.
- `prepareLoopStep`: for `role: implement`, write the plan artifact (the loop's document is the run's
  plan) to `.agentflow-ai/work/plan.md`; for `role: plan` on a fresh loop, remove a stale `plan.md`.
- Outputs are collected like other step files: the engine adds the role files to the step's
  `artifacts` in `toLoopStepConfig`, first, so they always fit (`LOOP_STEP_FILE_BYTES_MAX` 200 KB).

### Engine

- `engine/documents.ts`: `withPlanDocument` also when a step has `role: plan`, so the run gets its
  plan document (source: the PRD or the Issue) at ingest, and STEP loops use it as their document.
- `engine/agent-step.ts` `settleAgentStep`, `role: plan`:
  - questions written → `needs_input` as today;
  - no `plan.md` → `outputRepair` (new `RunStepState.outputRepair`, like `questionsRepair`): resume
    the session once with "write the plan to …"; still missing → `step_failed` ("The Plan step did
    not write .agentflow-ai/work/plan.md");
  - `plan.md` → new version of the run's plan document (status DRAFT, `resetDocumentRoom`), event
    `plan.completed` (and `plan.started` when the step starts), so existing `{{plan.url}}`,
    `{{plan.excerpt}}` and plan actions work.
- `role: implement`:
  - entering the step approves the plan document (`tryApprovePlan`), as EXECUTE does;
  - at settle: as a pushing step today (branches, Issue in review; a PRD marked executed like
    EXECUTE), plus release notes: published through `step-documents.ts` with a fixed target
    (`DOC`, title `Release notes: {{issue.key}} {{issue.title}}`), versions per round.
- `engine/snapshot.ts`: `releaseNotes` (text of the latest version, ≤ 30,000 chars) and its URL;
  `WORKFLOW_TEMPLATE_VARIABLES` gains `releaseNotes` and `releaseNotes.url`.

### App

- Process YAML editor completions and diagnostics for `role`, `releaseNotes`
  (`packages/app/projects/lib/process-yaml-completions.ts`, `process-yaml.ts`).
- Run page: the plan and release-notes documents under Work items (already listed for step
  documents; check the plan document shows for role steps).

### Tests

- Schema: role rules, defaults, error messages.
- Engine: role plan publishes versions per round; missing plan → repair → fail; implement approves
  the plan, publishes release notes, `{{releaseNotes}}` renders; process parity tests unchanged.
- Runner: contract text per role, `plan.md` written before implement, stale plan removed.

## Part 2 — Release notes for `agentflow.execute`

- `agent-plugins/code/prompts/execute-prompt.md` final phase: when `AGENTFLOW_RELEASE_NOTES=1`,
  write `$AGENTFLOW_WORKDIR/release-notes.md` (same format as Part 1). Plugin change: needs the
  owner's go-ahead, as earlier plugin changes did.
- Runner: sets the variable from the loop's agent policy (`agent-policy-env.ts`), uploads the file
  with the EXECUTE artifacts.
- Engine `stepExecuting`: publish it like Part 1 when EXECUTE completes.
- Tests: plugin script test for the file, engine publish on EXECUTE completion.

## Part 3 — Review loops

### Schema

```ts
const signalLabelsSchema = z.array(z.string().trim().min(1).max(255)).max(10).default([]);

export const ReviewSession = { Resume: "resume", Fresh: "fresh" } as const;

const stepReviewSchema = z.object({
  /** Plan steps: the plan is approved. */
  approve: z.object({ labels: signalLabelsSchema }).optional(),
  /** Other steps: the review is over (e.g. code review done). */
  complete: z.object({ labels: signalLabelsSchema }).optional(),
  feedback: z.object({
    labels: signalLabelsSchema,
    mention: z.boolean().default(false),
  }).default({}),
  /** Prompt of a feedback round: {{feedback.text}}, {{feedback.author}}, {{feedback.via}}, {{review.round}}, issue variables. */
  instruction: z.string().trim().max(PROCESS_INSTRUCTION_MAX).optional(),
  session: z.enum(ReviewSession).default(ReviewSession.Resume),
  consumeLabels: z.boolean().default(true),
});
```

- `review` optional on `agentStepSchema`. `approvalStepSchema` gains `approve: { labels }` (the
  same signal shape, approve only).
- Validation: `approve` only on `role: plan` steps, `complete` only on other steps; a label is in
  at most one list. Without labels the step is still decided in AgentFlow (buttons).
- `runStepStateSchema.review`: `{ stepId, loopId, round, requestedAt, decision | null, history[]
  (≤ 50: kind, via, text, by, at) }`; `pendingSignals[]` (≤ 10) for signals that
  arrive while the step works.
- `WorkflowRunErrorCode.ReviewRejected`.
- `POST /workflow-runs/{id}/review` input: `{ decision: approve | feedback | reject, comment }`.

### Engine

- New `engine/review-step.ts` (beside `approval-step.ts`):
  - `enterReview`: after the step settles without questions and a step has `review` → status
    `needs_approval`, event `input.needed`, `stepState.review` with the step's latest loop; a queued
    signal is applied at once.
  - `settleReview` (from `stepNeedsApproval`): approve → `approved` plan document for a plan step,
    then the next step (or `succeeded`); feedback → feedback round; reject → `failed`.
  - Feedback round: new cycle (`cycle + 1`, so `plan.started/completed` or
    `execute.started/completed` and `input.needed` fire again), launch the step: `resume` →
    `launchStepLoop` with `resumeLoopId` = the review's loop and the feedback prompt; `fresh` → the
    step's instruction plus the feedback. For `role: implement` the approved plan is written again;
    pushes go to the same branches, so pull request actions reuse the open pull requests.
  - Feedback prompt: who asked, through what, the text (a mention: that comment; a label: the
    ticket's comments written since the wait started, else "re-read the issue"), then the rendered
    `review.instruction`.
- `stepNeedsApproval` dispatches to `settleApproval` or `settleReview` by step state.
- Retry: a failed feedback round is retryable like any step (`retry-step.ts`).

### Signal routing (`engine/ingest.ts`, new `engine/review-signals.ts`)

- Provider hook on the inbound definition: `signalFacts(event) → { addedLabels, mentioned,
  commentId, actor } | null`. Jira maps `addedLabels`; Azure DevOps maps `addedTags`. Mention
  events gain a `commentId` attribute (Jira comment webhook, ADO `workitem.commented`).
- Before trigger matching, per event of a project connection: find active runs of that project
  connection and `sourceKey` whose current step has `review` (or an approval step with `approve`
  labels). Under the existing advisory lock:
  - waiting (`needs_approval`) and a signal matches → record the decision in `stepState`, remember
    the occurrence key (`occurrenceKeys`), advance the run in the background;
  - the step still works (`running` / `planning` / `executing`) → append to `pendingSignals`;
  - the event is then consumed for that workflow (no trigger matching, no new run); other workflows
    still see it. No matching signal → today's path (`needs_input` answers, triggers).
- The bot's own events are already dropped (`caused_by_bot`).

### Label consumption

- After a label signal is applied and `consumeLabels`, the engine removes the label from the source
  item through the provider's label operation (Part 4), with the action retry/backoff, recorded on
  the run (shown with the review history). A failure never fails the run.

### API and app

- `POST /workflow-runs/{id}/review` (`apps/api/app/workflow-runs/[runId]/review/`): approve/reject org
  admins, feedback any member; 409 when the run does not wait for a review.
- `RunProcessView.review`: step, round, requested at, the configured signals (to show "add label
  plan-approved / mention @bot"), history, pull request states.
- `packages/app/workflows/components/workflow-run-process-card.tsx`: review panel with Approve,
  **Approve** + **Replan** on a plan step, **Done** + **Request changes** on other steps (the
  feedback buttons open a text box), **Reject**; history. Done is the way to finish a run whose
  source has no labels (HTTP trigger, manual run).
- `input.needed` summary for a review wait: what it waits for and how to answer (labels, mention,
  AgentFlow link), so `{{summary}}` works without an instruction.
- Run timeline labels (`packages/app/workflows/lib/workflow-run-timeline.ts`), YAML completions.

### Tests

- Engine: wait → approve → next / succeed; feedback → resume (and fresh) → wait again with
  `round + 1`; complete by label and by Done; queued signals; reject; retry of a failed round.
- Ingest: label/mention signals reach the waiting run and never create a run; duplicates ignored;
  unmatched events keep today's behaviour; other workflows unaffected (real-DB integration test like
  `definition-registry-realdb.test.ts`).
- Routes: permissions, 409. UI: panel states.

## Part 4 — Source item labels and links

- `SourceOperation` gains `Label: "label"` and `Link: "link"` (`connection-grants.ts`).
- Jira: `jira.update_labels` (`{ add, remove }`, `PUT /issue/{key}` with `update.labels`) and
  `jira.add_link` (remote link, `POST /issue/{key}/remotelink`). Azure DevOps:
  `azure_devops.update_tags` (`System.Tags` patch) and `azure_devops.add_link` (Hyperlink relation).
  All `sourceOperation`-bound, usable as typed actions and through grants.
- Tools: `source_item_label` and `source_item_link` (`source: [label]`, `source: [link]`);
  `source_item_get` returns the item's links (`SourceItem.links`), so an instruction can remember
  "the plan page" as a link on the ticket instead of in a comment.
- Tests: provider request shapes, skip when the source is another provider, tool planning.

## Part 5 — Pull request review tools (Bitbucket Cloud and Azure DevOps)

Status: implemented. Tool names as shipped: `pull_requests_list`, `pull_request_threads`,
`pull_request_reply`, `pull_request_resolve`; `mine` is computed by the API
(`app/integration-tools/service/pull-requests.ts`), not by the provider, which returns `authorId`.
Docs: workflows.md "Integration tools".

### Provider interface (`apps/api/lib/integrations/types.ts`)

```ts
export type PullRequestState = "open" | "merged" | "declined";

export type PullRequestComment = {
  id: string;
  author: string | null;
  /** Written by this connection's account or recorded as written by this run. */
  mine: boolean;
  createdAt: string | null;
  bodyMarkdown: string;
};

export type PullRequestThread = {
  id: string;                       // Bitbucket: root comment id; Azure DevOps: thread id
  status: "open" | "resolved";
  file: { path: string; line: number | null } | null;   // null: a general comment
  comments: PullRequestComment[];   // root first
};

pullRequests?: {
  /** State shown by pull_requests_list; never a review signal. */
  get(ctx, repository, number): Promise<RepositoryOperationResult<{ state: PullRequestState; url: string }>>;
  listThreads(ctx, repository, number): Promise<RepositoryOperationResult<PullRequestThread[]>>;
  reply(ctx, repository, number, threadId, markdown): Promise<RepositoryOperationResult<{ commentId: string }>>;
  resolve(ctx, repository, number, threadId): Promise<RepositoryOperationResult<void>>;
};
```

Added to `IntegrationRepositoriesDefinition`.

### Implementations

| | Bitbucket Cloud (`providers/bitbucket/pull-requests.ts`) | Azure DevOps (`providers/azure-devops/pull-requests.ts`) |
|---|---|---|
| State | `GET …/pullrequests/{id}`: `OPEN` / `MERGED` / `DECLINED` (`SUPERSEDED` → declined) | `GET …/pullRequests/{id}`: `active` / `completed` / `abandoned` |
| Threads | `GET …/pullrequests/{id}/comments` (paged): roots + replies by `parent.id`, `inline.path` / `inline.to`, `deleted` skipped, resolution from the comment's `resolution` | `GET …/pullRequests/{id}/threads`: `threadContext.filePath` / `rightFileStart.line`, `status` (`active`/`pending` → open, others → resolved), system comments skipped |
| Reply | `POST …/comments` with `parent.id` | `POST …/threads/{threadId}/comments` with `parentCommentId` |
| Resolve | `POST …/comments/{id}/resolve` | `PATCH …/threads/{threadId}` `{ status: "fixed" }` |
| Scopes | existing pull request read/write | existing Code (Read & write) |

`mine`: the author is the connection's account, or the comment id is an `externalRef` of this run's
recorded tool calls (Bitbucket access tokens have no account). Rate limits and 5xx are retryable.

### Tools (`agent-tools/catalog.ts`, `IntegrationToolName`)

- Reserved grant key `pull_requests` (`connection-grants.ts`; outside the project connection key
  pattern, which has no underscore): `read`, or `[reply, resolve]`.
- `pull_requests_list` (always with any `pull_requests` grant): the run's pull requests (repository,
  URL, number, state).
- `pull_request_threads_get({ pullRequest, status: open | all })`.
- `pull_request_reply({ pullRequest, threadId, body })`, `pull_request_resolve({ pullRequest,
  threadId })`.
- `pullRequest` is an enum of the run's pull request URLs, so the agent can only act on its own pull
  requests; the server resolves the repository and its connection. Providers without `pullRequests`
  answer "not supported for <provider>".
- New `PlannedToolCall` kinds; carried out in `apps/api/app/integration-tools/service/execute.ts`,
  recorded in `integration_tool_calls` (keyed, so a repeat is not written twice).
- `PROCESS_STEP_TOOL_WRITES_MAX` 20 → 100.

### Tests

- Provider clients against recorded responses (paging, replies tree, inline context, resolve,
  errors). Catalog description rules (`catalog.test.ts`), enum pinning, refusals. Execute: budget,
  idempotency, `mine`.

## Part 6 — Confluence

Status: implemented. Differences from the plan: find by space + title is `find_pages` (`get_page` takes an
id or link); replies are read one level deep; comment authors are account ids (no user lookup). The
project connection's settings reach providers as `ConnectionRuntime.projectSettings`. Docs:
workflows.md "Confluence" and "Integration tools".

### Provider (`apps/api/lib/integrations/providers/confluence/`)

- Cloud only. Connection: `siteUrl`, `email`, secret `apiToken`; the Atlassian auth (Basic, scoped
  tokens through the API gateway with the cloud id) moves from `providers/jira/auth.ts` to
  `providers/atlassian/` and serves both providers (gateway path `ex/confluence/{cloudId}`).
- Project settings: `spaceKeys` (required) and an optional `parentPageId` for new pages. No triggers,
  no inbound, no source items, no claims.
- Bot identity from `validate` (the account id), used to mark the bot's own comments.

### Provider reads (framework)

- `IntegrationProviderDefinition.reads?: IntegrationReadDefinition[]` (`key`, `displayName`,
  `description`, zod input schema + `ToolProperty` list, `execute(ctx, input) → JsonValue`). The
  catalog offers `<provider>_<read>` tools to every key granted `read` or any write on that provider,
  with the `connection` enum like external writes.

### Operations

| Operation | Kind | Notes |
|---|---|---|
| `confluence.get_page` | read | By link (`/wiki/spaces/{key}/pages/{id}`, short links resolved within the site), id, or space + title. Returns title, space, version, parent, body as Markdown (default) or `storage` (to edit in place keeping inline comment markers). |
| `confluence.find_pages` | read | By title within the allowed spaces (to confirm "the plan page" from the ticket's title). |
| `confluence.list_comments` | read | Footer and inline comments with replies; inline: the highlighted text and resolution status; `mine` per comment; filter open / all. |
| `confluence.create_page` | write | Space (allowed), parent (default `parentPageId`), title, body (Markdown → ADF, or storage). |
| `confluence.update_page` | write | Body and title with `baseVersion`: refused when the page changed since it was read. |
| `confluence.comment` | write | A footer comment, or a reply to any comment. |
| `confluence.resolve_comment` | write | An inline comment. |

- Every operation resolves the page's space and refuses spaces outside `spaceKeys` (the link comes
  from untrusted ticket text).
- Markdown → ADF: the Jira converter (`providers/jira/adf.ts`) moves to `providers/atlassian/adf.ts`.
  Storage → Markdown: `lib/integrations/markdown.ts` (already handles Confluence tables).
- Writes are actions too (usable as typed workflow actions, e.g. publish `{{steps.plan.reply}}`).

### Tests

- Client against recorded responses (pages, comments, children, gateway), space guard, version
  conflict, converters, catalog tools.

## Part 7 — Later: pull request webhooks

Bitbucket (`pullrequest:comment_created`, `pullrequest:changes_request_created`,
`pullrequest:fulfilled`) and Azure DevOps service hooks (pull request updated, commented): route by
pull request URL to the run that opened it and feed Part 3 signals (feedback on "changes requested"
or a comment that mentions the bot). Merges stay informational: completion comes from the ticket.

## Rollout

1. Part 1 + Part 2 (roles, release notes). Ship with the docs; the Calculator workshop process drops
   its `release-notes` step.
2. Part 4 (labels and links), then Part 3 (review loops) on top of it.
3. Part 5 (pull request tools).
4. Part 6 (Confluence).
5. Part 7 when teams ask for feedback straight from the pull request.

Every part updates `docs/workflows.md` (process steps, run state machine, signals, providers,
integration tools, template variables) in the same change, and the runner image is rebuilt for
Parts 1, 2 and 3.

## To verify while implementing

- What the plan view, Evaluate Plan and implement steps need from a plan written by a toolkit
  (sections, checklist, open questions) — fixes the plan contract text.
- That a STEP loop on the plan document receives both the plan and the source (PRD/Issue) artifacts.
- Loop workspace cleanup on the runner keeps the workspaces of runs that wait (reviews last days).
- Bitbucket Cloud: the comment resolve endpoint and the `resolution` field.
- Azure DevOps: thread statuses to treat as open; system threads.
- Confluence Cloud v2: inline comment resolve (`resolved` on update), behaviour of inline comments
  whose highlighted text is removed, token scopes for a scoped API token.
- The project connection code accepts a provider with settings and no claims (Confluence spaces).
- Azure DevOps `workitem.commented` payload carries the comment id.

## Open questions

None at this time.
