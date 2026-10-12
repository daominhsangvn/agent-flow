# Workflows and integrations

Event-driven automation for the self-hosted edition. The admin defines the
whole flow of a **workflow**:

```
trigger(s)  ->  pre actions  ->  agent team  ->  post actions
            (in order, before    (import, PLAN,   (on run events:
             the agent team)      optional         plan ready, needs
                                  EXECUTE -> PR)   input, succeeded, failed)
```

- **Triggers** come from external systems: a Jira issue assigned to the bot,
  an Azure DevOps work item assigned to the bot, a signed HTTPS request, ...
- **Pre actions** run right after a trigger fires, one after another in the
  configured order, before the agent team starts: e.g. move the Jira issue to
  "In Progress", set the Azure DevOps state to "Active", tell a Teams channel.
  A failed pre action stops the run unless it is marked "continue on error".
- The **agent team** imports the item (as a **PRD** when it is a product
  requirement, item type "PRD"; as an **Issue** otherwise) and runs on a desktop compute
  target: PLAN, then optionally EXECUTE, which opens a pull request.
- **Post actions** run on run events: comment the PR link on the ticket,
  transition it to "In Review", post to Teams, call an HTTPS endpoint, ...

**The engine never writes to a source system on its own.** Receiving a
webhook, polling and importing the item only read. Every change in Jira,
Azure DevOps, Teams or anywhere else is a pre or post action the admin added
to the workflow. (The engine does update AgentFlow's own documents: it
approves the plan before EXECUTE and moves the imported Issue to in review, or
marks the imported PRD executed.)

Real use case: a BA writes a requirement in Jira and assigns it to the bot
account → the workflow whose Jira trigger matches starts a run → pre action:
transition the issue to "In Progress" → the agent team plans and implements it
→ post actions comment the PR link back on the Jira issue, transition it to
"In Review" and notify a Teams channel.

Nothing about a provider is hardcoded in the engine or the UI. Providers are
plugins registered in `apps/api/lib/integrations/registry.ts`; the engine and
the UI discover their triggers, actions and config fields from the registry.

An integration connection is the only place credentials live. Its provider
declares **capabilities**: `triggers`, `actions` (pre and post) and
`repositories`. Installing Azure DevOps, for example, gives work item
triggers, comment/state/pull request/pipeline actions and Azure Repos
repositories, all through the same PAT; when each operation runs is decided
in the workflow. See "Project repositories" below.

## Concepts

| Concept | Where | Notes |
|---|---|---|
| Provider | `apps/api/lib/integrations/providers/<key>/provider.ts` | Implements `IntegrationProviderDefinition` (`apps/api/lib/integrations/types.ts`). Declares connection fields, inbound handling (webhook / poll), source item fetching, trigger types and action types. Never touches the database. |
| Connection | `integration_connections` | An authenticated account in a provider (a Jira site + bot API token, an ADO org + PAT, a Teams Workflows URL, a webhook endpoint). Secrets sealed with AES-256-GCM. One connection serves any number of workflows. |
| Delivery | `integration_deliveries` | A verified inbound event batch (webhook request, poll result, manual run). Unique per `(connection, deliveryId)`, so provider retries are absorbed. |
| Workflow | `workflows` | Name, project, run-as user, agent config, ≥1 trigger, ≥0 actions. |
| Trigger | `workflow_triggers` | `(connection, type, config)`. `type` is a provider trigger key such as `jira.issue_assigned`. A workflow may have several triggers on different connections. |
| Action | `workflow_actions` | `(connection, type, config, stage, events[], continueOnError)`. `type` is a provider action key such as `jira.add_comment`. Stage `pre`: runs on `run.triggered`, in order, before the agent team. Stage `post`: runs on the subscribed run events. Any action type can be used in either stage. |
| Project repository | `project_repositories` | A repository a project works on, added from a connection whose provider has the `repositories` capability (GitHub, Azure DevOps, Bitbucket, Local Git); with the `repository_creation` capability (Local Git) the project can also create a new one. Stores only the provider's id, name, URLs and default branch; no token. All of a project's repositories are equal to its agents; the first one only anchors the loop's branch record. |
| Run | `workflow_runs` | One execution for one source item occurrence. Owns the imported PRD or Issue, the plan document and the loops. `repository` is the project repository EXECUTE works in (`RunRepositorySnapshot`). |
| Run loop | `workflow_run_loops` | Loops that belong to a run (launched by the engine, or adopted). |
| Action run | `workflow_action_runs` | One execution of an action for a run event, retried with backoff. Unique per `(run, action, event, cycle)`. Pre rows are executed by the run state machine, post rows by the outbox drain. |

Shared wire contracts: `packages/api/src/types/integration.ts` and
`packages/api/src/types/workflow.ts`.

## Code layout

```
apps/api/lib/integrations/
  types.ts                 provider contract (IntegrationProviderDefinition, InboundEvent, SourceItem, ActionResult, ...)
  registry.ts              the ONLY list of providers + lookups + toProviderSummary
  http.ts                  ProviderHttp (timeouts, never throws, retryable classification)
  inbound-auth.ts          verifyHubSignature / verifyStaticToken / verifyStandardWebhook / generateInboundSecret
  markdown.ts              htmlToMarkdown, truncateText
  connection-service.ts    CRUD, sealing secrets, runtime loading, validation, inbound key/secret
  repositories.ts          repository listing/reading through a connection (repositories capability)
  pull-request-action.ts   "Create pull request" action shared by every provider with repositories
  connection/
    credential-origin.ts   re-enter secrets when a credential origin field changes
    url-redaction.ts       url-kind config values as origin only for non-admin readers
  providers/
    jira/                  Jira Cloud + Data Center
    azure-devops/          Azure DevOps Services (work items, Azure Repos, Pipelines)
    github/                GitHub / GitHub Enterprise Server (fine-grained PAT; repositories)
    bitbucket/             Bitbucket Cloud (API token or access token; repositories)
    local-git/             Local Git = the docker-compose Gitea (token; repositories, creating them)
    microsoft-teams/       Teams Workflows (Power Automate) webhook
    webhook/               generic HTTPS (Standard Webhooks)
apps/api/lib/workflows/
  workflow-service.ts      workflow CRUD, enable/disable, read redaction
  workflow-validation.ts   save validation (registry, scope, compute target rule)
  run-service.ts           run queries, DTO mapping, cancel, retry action run
  template.ts              {{variable}} renderer
  engine/
    ingest.ts              deliveries -> trigger matching -> runs (dedupe, resume)
    advance.ts             run state machine (lease-guarded, idempotent)
    phases.ts              one step per run status
    pre-actions.ts         the pre_actions step (inline, in order)
    run-loops.ts           run <-> loop mapping, revivable TIMED_OUT check
    step-retry.ts          step retry backoff (stepAttempts / nextStepAt)
    launch.ts              programmatic PLAN/EXECUTE launcher (no HTTP)
    documents.ts           PRD or Issue + plan document creation / refresh
    source-document.ts     which items are PRDs; their statuses
    snapshot.ts            WorkflowRunSnapshot + summary markdown for actions
    run-repository.ts      run.repository at EXECUTE launch; action outputs (pull request) -> run
    actions.ts             outbox enqueue + drain
    poll.ts                due-connection polling
    tick.ts                one scheduler tick (poll, sweep runs, drain outbox)
apps/api/lib/self-hosted-cron.ts   in-process cron runner started by server.ts
apps/api/app/integrations/**       connection + provider catalog routes
apps/api/app/projects/project-repository-service.ts   project repositories (add/list/primary/remove)
apps/api/app/projects/[id]/repositories/**             project repository routes
apps/api/app/workflows/**          workflow routes
apps/api/app/workflow-runs/**      run routes
apps/api/app/webhooks/integrations/[inboundKey]/route.ts   public ingress
apps/api/app/cron/workflows/route.ts                       scheduler tick
packages/app/integrations/**       connection UI (hooks + components)
packages/app/projects/components/project-repositories-panel.tsx   Project -> Repos popover
packages/app/workflows/**          workflow UI (hooks + components)
apps/app/app/(authenticated)/[orgSlug]/workflows/**        pages
```

## Inbound

### Webhook

`POST /webhooks/integrations/{inboundKey}` (public; no session auth).

1. Look up the connection by `inboundKey` (unknown key → 404 with a generic
   body; disabled connection or delivery mode ≠ webhook → 200 `{ok:true}`,
   logged as ignored, so retries stop).
2. Read the raw body with a 1 MB cap (`readCappedRequestText`).
3. `provider.inbound.verify(request, {connection, inboundSecret})` →
   401 on failure. Verification is constant-time.
4. `provider.inbound.parse(request, ctx)` → `{deliveryId, eventType, events}`.
5. `ingest(...)` (below), then answer **200** `{ok:true}` fast. Jira counts
   only 200 as success; ADO puts subscriptions on probation for 404/5xx, so
   never answer those for an event we merely ignore. Processing continues in
   `waitUntil`.

Every return path calls `scheduleLogFlush()` and logs one terminal
`outcome` line, per `apps/api/app/webhooks/AGENTS.md`.

Verification by provider:

| Provider | Accepted credentials |
|---|---|
| Jira | `X-Hub-Signature: sha256=<hex>` (admin webhook with secret) **or** `X-AgentFlow-Token` header (Jira Automation "Send web request") |
| Azure DevOps | `X-AgentFlow-Token` header **or** Basic auth whose password is the secret (service hook settings) |
| Webhook (HTTPS) | Standard Webhooks signature (`webhook-id`/`webhook-timestamp`/`webhook-signature`, secret `whsec_...`) **or** `X-AgentFlow-Token` |
| Microsoft Teams | no inbound side |

Static tokens are never accepted in `Authorization: Bearer` (the API
middleware treats bearer values as session JWTs).

The inbound URL is `${PUBLIC_WEBHOOK_BASE_URL ?? NEXT_PUBLIC_API_URL}/webhooks/integrations/{inboundKey}`.
Jira Cloud and Azure DevOps must reach it over public HTTPS (Jira Cloud
allows port 443 among a few others; ADO refuses localhost/private IPs). For a
machine behind NAT use a tunnel/reverse proxy, or switch the connection to
**poll** mode.

### Poll

For connections with `deliveryMode = poll`, every scheduler tick polls the
connections whose `nextPollAt` is due (bounded concurrency), calling
`provider.inbound.poll(ctx, cursor)`. The returned events go through the same
`ingest` path, one delivery per event (`deliveryId = "poll:" + dedupKey`),
then `pollCursor`, `lastPolledAt` and `nextPollAt = now + pollIntervalSeconds`
are saved. A failed poll records `lastError` and backs off to the next
interval. A null cursor means "first poll": providers return no backlog older
than a few minutes. Changing `pollIntervalSeconds` on a polling connection
takes effect at once: `nextPollAt` moves to at most one new interval from now
(a poll already due sooner keeps its time). Entering poll mode or re-enabling
a polling connection polls right away.

Providers derive `dedupKey` the same way for webhook and poll (e.g. from the
Jira changelog id or the ADO revision), so switching modes never duplicates
runs.

### Manual

`POST /workflows/{id}/runs {triggerId, input}` builds an event with
`provider.source.resolveManual(ctx, input, triggerType)` (a Jira issue key, an
ADO work item id, a JSON body for the webhook provider). Trigger filters are
**not** applied (the admin chose the item explicitly). The engine appends
`:manual:<deliveryUuid>` to the dedupKey so a manual run always starts. A
failure of `resolveManual` (unknown key, source system unavailable) is
returned to the caller right away as a 400; nothing is retried.

## Ingest

`ingestEvents({connection, source, deliveryId, eventType, events, payload})`:

1. Insert the delivery (`createMany` + `skipDuplicates` on
   `(connectionId, deliveryId)`); if it already existed → outcome `duplicate`,
   stop.
2. For each event, load enabled triggers with `connectionId = connection.id`,
   `type = event.triggerType` whose workflow is enabled. Parse the trigger
   config with the provider's `configSchema` (invalid → skip, log) and call
   `trigger.matches(event, config, connection)`.
3. For a matching trigger, with `sourceKey = provider + ":" + item.key`:
   - if the workflow already has a run whose `dedupKey` is this key or whose
     `occurrenceKeys` contain it → nothing;
   - else if it has an **active** run for this `sourceKey`:
     - status `needs_input` → **resume** it: `cycle += 1`, append the
       event's dedupKey to `occurrenceKeys`, store the new event in
       `source`, status `pre_actions` when the workflow has enabled pre
       actions, else `ingesting` (the Issue document is refreshed from the
       source and PLAN runs again on the same plan document); the step
       retry state (`stepAttempts`, `nextStepAt`) is reset like on every
       status change. That second PLAN is a **re-plan**: the context pack
       carries `replan: true` (`isRunReplanLoop`, a PLAN loop of a run that
       already completed one), and the computer hands it the earlier plan
       (`previous-plan.json`, else the plan document as `previous-plan.md`)
       plus the earlier exploration when the repository is still at the
       commit it explored (`loop-replan.ts`), taken from the plan's saved
       state (docs/runner.md "Plan state"), so the re-plan may run on another
       computer than the first PLAN. The orchestrator then revises
       that plan with the answers now in the source document - same tasks
       and IDs, answered questions applied, unanswered ones kept - instead
       of exploring and drafting again, and still stops for review. The
       revision marks each answer and gap resolution it applied to the tasks
       (`"applied": true` in plan.json), so EXECUTE does not process them
       again (prompt.md phases 1.2/1.2a). A PLAN outside a workflow run
       always plans from scratch;
     - any other active status → nothing (`detail: "run already active"`);
   - else create a run: status `received`, `agentConfig` snapshot of the
     workflow, `runAsUserId` of the workflow, `source = {item, inlineItem?,
     actor, attributes, extras, occurredAt}`. The unique
     `(workflowId, dedupKey)` index makes concurrent inserts safe (P2002 →
     treat as existing).
4. Update the delivery: outcome `accepted` with `runCount`, or `ignored` with
   the reason; `lastDeliveryAt` on the connection.
5. `waitUntil(advanceRun(runId))` for every created or resumed run.

## Run state machine

`advanceRun(runId)` is the only writer of run status. It is idempotent and
guarded by a lease: `updateMany where id and (leaseUntil is null or <
now) and (nextStepAt is null or <= now)` sets `leaseUntil = now + 2 min`; if
no row is updated another worker owns the run (or its step waits for a retry,
see below) and the call returns. The lease is cleared in `finally`. Every
status change sets `phaseStartedAt`, resets `stepAttempts = 0` and
`nextStepAt = null`, and enqueues the transition's run events in the same
transaction. The enqueued action runs are due at the transition time (the
advance's `now`), so a new run's pre actions execute in the same call that
entered `pre_actions`.

| Status | Step |
|---|---|
| `received` → `pre_actions` | Enqueue `run.triggered` for the workflow's enabled **pre** actions (stage `pre`, current cycle). No pre actions → straight to `ingesting`. |
| `pre_actions` | Execute the cycle's pre action runs **one at a time in action position order**, inline, with the same executor and retry/backoff as post actions. The first non-final row decides: due → execute now and continue with the next; waiting for its backoff → stop (the tick advances the run later). A row that ends `failed` stops the run with `pre_action_failed` ("Pre action <display name> failed: <error>") unless the action has `continueOnError`; `skipped` rows count as done. All rows final → `ingesting` in the same call. Pre actions see a snapshot with event `run.triggered`, status `pre_actions` and no documents yet. |
| `ingesting` | Validate the workflow (enabled, project, run-as user is an active org member, compute target configured). Load the connection runtime. Get the item: `inlineItem` or `provider.source.fetchItem(ctx, item)`. A temporary source failure (`RetryableSourceError`: rate limited, 5xx, timeout, network) keeps the run in `ingesting` and retries the step after 30 s, 2 min, 10 min, 30 min (`stepAttempts += 1`, `nextStepAt = now + backoff`); the fifth failed attempt fails the run with `source_fetch_failed`. Any other fetch error fails the run at once. Create (or, on resume, refresh) the **source** document in the workflow project with the title from `agent.titleTemplate`: a **PRD** (`DocumentType.Prd`, status `APPROVED`, the item's description as its body) when the item type names a product requirement (`prd`, "Product Requirements Document", ...; `source-document.ts`), else an **Issue** (`DocumentType.Feature`, status `IN_PROGRESS`, the markdown body below); then the **plan** document (`DocumentType.ImplementationPlan`, `sourceId` = the PRD or Issue, status `DRAFT`): the plan is generated from the PRD like the "Generate plan" flow of a PRD written in AgentFlow, mirroring `resolveOrCreatePlanDocument` in `app/documents/execution-service.ts`. Record activity with `captureArtifactCreation` (`authMethod: "api_key"`, shown as an agent). Launch PLAN. On success → `planning` and enqueue `run.started` (cycle 1 only). |
| `planning` | Read the latest run loop with command PLAN. Not terminal → wait. A revivable `TIMED_OUT` loop (below) → wait. `COMPLETED` → enqueue `run.plan_ready`; open questions come from the plan's uploaded artifacts (`lib/loops/uploaded-plan-artifacts.ts`). Mode `plan` → `succeeded`. Mode `plan_and_execute`: open questions and `stopOnOpenQuestions` → `needs_input` (+ `run.needs_input`); otherwise set the plan document status `APPROVED` and launch EXECUTE → `executing`. Any other terminal status (`FAILED`, `CANCELLED`, a `TIMED_OUT` that can no longer be revived) → `failed` with the loop error. |
| `executing` | Latest EXECUTE run loop. Not terminal, or a revivable `TIMED_OUT` → wait. `COMPLETED` → store `prUrl`/`branchName` (loop fields or `primaryPullRequest`), set the Issue status to in-review (a PRD: executed), → `succeeded`. Other terminal statuses → `failed`. |
| `needs_input` | Adoption: a loop created on the plan document after `phaseStartedAt` and not yet mapped is attached to the run (`adopted = true`): PLAN → `cycle += 1` (so `plan_ready` / `needs_input` post actions fire again; pre actions do not run) and `planning`; EXECUTE → `executing`. A re-assignment of the source item resumes the run through ingest (pre actions run again for the new cycle). |
| `running` | An agent step of the project's process (below): wait for its STEP loop, then the next step. |
| `needs_approval` | An approval step of the project's process (below): wait for an admin's decision. |
| `succeeded`, `failed`, `cancelled` | Final. Later loop changes (a FAILED loop later reported COMPLETED) are ignored. |

Entering `succeeded` enqueues `run.succeeded`, entering `failed` enqueues
`run.failed`. Runs in `planning`/`executing` longer than
`WORKFLOW_RUN_PHASE_TIMEOUT_HOURS` (default 24) fail with `phase_timeout`.

**Project process.** The steps between pre actions and post actions are a
*process* (`packages/api/src/types/project-process.ts`): an optional toolkit
(a project repository whose skills/commands directories the agent loads) and
an ordered list of steps. Step types are code (`agentflow.plan`,
`agentflow.execute`, `agent`, `approval`); the process itself is data, stored
as append-only versions in `project_process_versions` (the highest version is
current). The engine (`engine/process.ts`) resolves it at `ingesting`:

- The run already has a snapshot (`workflow_runs.process`, a resumed run) →
  keep it.
- The workflow has its own process (`agent.process`, below) → snapshot
  `{version: 1, source: "workflow", definition}`.
- The project has a process version → snapshot `{version, source:
  "project", definition}` on the
  run and track the current step in `workflow_runs.step_id`. A later edit of
  the project's process does not change a run in progress. A stored version
  that no longer parses fails the run with `agent_config_invalid`.
- Otherwise → the **built-in AgentFlow flow**, derived from the workflow's
  agent config (`deriveProcessFromAgentConfig`): `plan` mode is `[plan]`,
  `plan_and_execute` is `[plan, execute]`, and `stopOnOpenQuestions` is the
  plan step's questions policy (`ask` / `continue`). Such a run writes neither
  `process` nor `step_id`, and its statuses, events and loops are exactly the
  ones in the table above (`__tests__/process-parity.test.ts` compares both).

**A workflow's own process.** `agent.process` (null by default) gives one
workflow steps of its own, so a project can run different processes per
workflow: for example one workflow analyses new requirements (an agent step
that asks, then an approval) while another answers the questions people ask
on the same tickets (one agent step whose reply is posted back). It is saved
with the workflow (no versions; a run keeps the snapshot it started with),
validated like the project's (its toolkit must be one of the project's
repositories), and edited in the workflow editor's Agent team → **Process**
choice ("The project's process" / "Its own process", starting from the
project's). Runs show "The workflow's own process" instead of a version.

`agentflow.plan` runs in `planning` (questions → `needs_input` when its
policy is `ask` and a step follows), `agentflow.execute` in `executing`. The
step after each one decides the next transition; no next step → `succeeded`.

**Agent decisions.** Two settings say what the AgentFlow agents of these
steps decide on their own. The defaults are the built-in flow's behaviour,
and only a step that changes one sends it with its loop (`agentPolicy` in
the loop metadata, `engine/launch.ts`; the context pack and the computer's
request carry it; the computer sets an environment variable for the agents,
`apps/desktop/src/server/operations/agent-policy-env.ts`).

```yaml
steps:
  - type: agentflow.plan
    id: plan
    name: Plan
    questions: ask            # stop the run on open questions
    recommendations: suggest  # accept (default) | suggest
  - type: agentflow.execute
    id: execute
    name: Implement
    review: fast              # full (default) | fast
```

- `recommendations` (plan step). The planning agents give most open questions
  a recommended answer. `accept` lets that recommendation settle the question
  when the plan is validated, so only questions without one stop the run.
  `suggest` keeps every open question open with the recommendation as a hint
  (`AGENTFLOW_PLAN_RECOMMENDATIONS=suggest`; `validate_plan.py` skips its
  `recommendedAnswer` fallback), so with `questions: ask` the run waits for
  people. With `questions: continue` the run goes on and the implementation
  uses the recommendations.
- `review` (implement step). `full` evaluates the approved plan, checks other
  repositories, runs the critics and finalizes it (phases 1.3–2.7 of the code
  plugin's orchestrator) before implementing, then checks the result against
  the plan's decision table (5.5). `fast` implements the plan as it is; tests,
  code simplification and build validation still run
  (`AGENTFLOW_EXECUTE_REVIEW=fast`; `plan_review: "fast"` in the plan
  validator's output). `fast` saves roughly the 10–20 minutes the review takes.

These settings belong to workflow runs. The plan and Execute actions on a
document keep the defaults.

**Approval steps** (`approval`, `engine/approval-step.ts`) move the run to
`needs_approval` and enqueue `run.needs_input`, so the post actions that
notify people fire. `workflow_runs.step_state.approval` records the step and
when it was requested. An org admin decides with
`POST /workflow-runs/{id}/approval` (`{approved, comment}`); the decision is
stored on the step state and the run is advanced: approved → the next step
(on the same computer for an agent step), or `succeeded` when the approval was
the last step; rejected → `failed` with `approval_rejected` and the comment.
The step's `show` entries (step ids or workspace path globs) pick the step
files the run page shows next to the decision.

**One notification per wait.** Post actions run once per event and cycle
(`workflow_action_runs` is unique on run, action, event and cycle), and a
process run can wait several times. An answer or an approval given in
AgentFlow therefore resumes the run in a new cycle (`cycle += 1`, like an
adopted plan), so each later wait enqueues `run.needs_input` again; answers
on the source item already start one through ingest. Pre actions do not run
for these cycles.

**Agent steps** (`agent`, `engine/agent-step.ts`) run in `running`, one
`STEP` loop each (`engine/launch-step.ts`):

- The loop works in the project repositories (integration connections), all
  of them in one workspace, from the workspace root. The run's plan document
  is the loop's document when the process has a `agentflow.plan` step (the
  steps then share PLAN / EXECUTE's workspace and branch), else its Issue; a
  process without a plan step gets no plan document.
- The run's first loop picks the computer like PLAN; every later step runs
  where the run's earlier loops ran, since the workspace is there. The run's
  first loop starts from a clean workspace (`fresh`); later steps continue
  its worktrees and work directory.
- The instruction is a template: `{{issue.key}}`, `{{issue.title}}`,
  `{{issue.url}}`, `{{issue.body}}` (the Issue document) and `{{issue.file}}`
  (the Issue as `.agentflow-ai/work/issue.md` in the workspace). One that
  starts with `/` (a toolkit skill or command) is passed to Claude Code as the
  prompt argument so it is expanded.
- The step's settings travel in the loop metadata (`step`,
  `@agentflow-ai/loops-api/loop-step`) and reach the computer with the loop.
  The computer links the toolkit's `mounts` from the toolkit repository's
  worktree into the workspace root (a directory the workspace already has
  keeps its own entries) and adds the step's section, with the toolkit's
  `instructions`, to the workspace `CLAUDE.md`.
- When the loop ends, the computer uploads `uploadedArtifacts.step`: the
  questions the agent wrote to `.agentflow-ai/work/questions.json` and the
  files matching the step's `artifacts` globs (at most 20 files, 200 KB each,
  1 MB in all). A step's `reply` file (a workspace path, e.g.
  `.agentflow-ai/work/answer.md`) is collected with them, first; post actions
  get the content of the latest step's reply as `{{reply}}` and each step's as
  `{{steps.<step id>.reply}}` (at most 30,000 characters each), for example a
  Jira comment `{{reply}}` that answers the question the run was started for,
  and an HTTPS call that hands `{{steps.email.reply}}` to a mail flow.
- A step's `document` (`{ type, path, title }`, "Publish as document" in the
  editor) makes one of its files a document of the workflow's project when
  the loop ends: a PRD (`PRD`, e.g. for a new feature), an Implementation Plan
  (`IMPLEMENTATION_PLAN`) or a general document (`DOC`, e.g. a bug analysis or
  a change request's impact). The file is collected like the reply; the
  document is created as a draft, produced by the run's Issue (a `PRODUCES`
  link whose metadata names the run and the step), and titled from `title`
  (`{{issue.key}}`, `{{issue.title}}`; empty: the Issue's title). Later loops
  of the step (after answers, a rejection, a new cycle) add versions to the
  same document; a loop that did not write the file publishes nothing. The run
  page lists the documents under Work items, and post actions link them as
  `{{steps.<step id>.document.url}}` (title: `{{steps.<step id>.document.title}}`).
  When publishing fails, the step's settlement is retried with the backoff of
  the run's step retries, then the run fails (`document_create_failed`).
- A `finish: push` step is committed and pushed like EXECUTE;
  its per-repository results set the run's repository branches for the pull
  request actions, and the Issue moves to review.
- A step with `questions: ask` that wrote questions moves the run to
  `needs_input` (`run.needs_input`) and records them in
  `workflow_runs.step_state` (`waiting`: step, loop, questions). The waiting
  run adopts no PLAN / EXECUTE loop.
- Questions the computer could not read (`questions.json` not JSON, or over
  the limits: 30 questions, 2,000 characters each, 10 options of 500
  characters each; the step's `CLAUDE.md` section states them) do not fail
  the step at once: the engine resumes the asking session once, on its
  computer, with the error and the limits (`step_state.questionsRepair`,
  the run stays `running`). If the rewritten file still cannot be read, the
  run fails (`step_failed`).
- Answers resume the step: a new `STEP` loop of the same step, on the
  asking loop's computer and in its workspace (`fresh: false`), whose
  `parentLoopId` is the asking loop, so the computer continues the agent
  session with `--resume` and the answers as the prompt
  (`engine/agent-step-resume.ts`). Answers come from
  `POST /workflow-runs/{id}/answers` (any org member; recorded in
  `step_state.waiting.answers`, unanswered questions are left to the agent),
  or from the source item: when it triggers the run again, `ingesting`
  refreshes the Issue and resumes the waiting step with the item's comments
  written after the step asked (or, without any, a pointer to the refreshed
  Issue) instead of starting the process over.
- A STEP loop that does not complete fails the run with `step_failed`; a step
  that asks but wrote questions that do not parse fails it too. The phase
  timeout applies to each step.

**In the app.** Project → **Process** shows the project's process (or "AgentFlow
(default)"), edits it from the AgentFlow or Spec Kit preset (toolkit, steps,
per-step settings), saves versions, lists the history and restores one; only
org admins save, and members see the process and its history without the
editing controls (the project's repositories, runners and agent instructions
are read-only to them the same way). The workflow editor hides the mode and open-questions
settings of a project that has its own process. A run's page shows a
**Process** card: the steps with the current one, the questions form while an
agent step waits (any member), the approval panel with the files to review
(Approve / Reject for admins) and every agent step's collected files. STEP
loops in the run's loop table carry their step name.

**Editing as YAML.** The process editor (Project → Process and a workflow's
own process) opens on the process as YAML
(`packages/app/projects/components/process-yaml-editor.tsx`, CodeMirror).
Suggestions appear while typing (`packages/app/projects/lib/process-yaml-completions.ts`):
the keys that fit at the cursor (a step's keys follow its `type`), their
allowed values, the project's repositories, step ids, step snippets on a new
`- ` item of `steps`, and the variables of an instruction after `{{`;
Ctrl+Space shows them anywhere. Problems are underlined as you type
(`packages/app/projects/lib/process-yaml.ts`): YAML syntax, the schema's issues
(the ones the API answers with) and unknown keys as warnings naming the closest
key; a syntax error blocks the save. The YAML is saved with the process as
`source` and shown again while it still describes the steps, so comments and
layout survive; a run's snapshot leaves it out (`withoutYaml` in
`engine/process.ts`). YAML is the only view by default; the
`process-form-editor` flag (off) adds a **Form** tab that edits the same draft
field by field: its edits regenerate the YAML (without the comments), and it is
disabled while the YAML does not parse.

**Revivable `TIMED_OUT` loops.** The loop reaper marks a desktop loop
`TIMED_OUT` after 2 h without a heartbeat (a sleeping laptop), and the loop
service brings it back to `RUNNING` on the next heartbeat
(`reviveTimedOutLoop` in `app/loops/service.ts`). The engine treats such a loop
as still running when it can still be revived by the same rules: the latest
`error` loop event carries a heartbeat-staleness reap reason
(`desktop_heartbeat_stale` or `desktop_no_heartbeat`), the loop's
`completedAt` is within `REVIVAL_GRACE_WINDOW_MS` (7 days) and its
`revivalCount` is below `REVIVAL_MAX_PER_LOOP` (3). The phase timeout bounds
the wait. A `TIMED_OUT` loop that fails any of these checks is final and
fails the run (`plan_failed` / `execute_failed`).

**Step retries.** `workflow_runs.stepAttempts` counts the failed attempts of
the current step and `nextStepAt` holds the run back until its backoff has
elapsed: `advanceRun` and the tick skip the run until then (cancel does not).
Both are reset on every status change (including a `needs_input` resume).
Today only the import of the source item retries this way.

Failures are values, not exceptions: every step maps its error to
`{code, message}` (`workflow_disabled`, `project_missing`, `run_as_user_missing`,
`source_fetch_failed`, `compute_target_unavailable`, `signing_required`,
`no_repository`, `concurrency_limit`, `loop_already_active`,
`dispatch_failed`, `plan_failed`, `execute_failed`, `plan_state_unavailable`,
`phase_timeout`, `cancelled`, ...). Messages are trimmed to 1000 characters
and never contain secrets.

### Launching loops

`engine/launch.ts` is the programmatic equivalent of
`POST /documents/{id}/run-loop` without HTTP objects:

1. `documentGenerationService.findWithRegenerationContext(planDocId, org)`.
2. Compute target: PLAN uses `agent.computeTargetId` through
   `resolveComputeTargetWithPreferences(org, runAsUserId, id)` (owned or
   org-shared, online). Which target a workflow may name is decided when it
   is saved or turned on (a private desktop only when the run-as user is the
   admin who saved it; see "API"). EXECUTE uses the PLAN's target:
   `loopsService.findLatestStateBearingDesktopForArtifact(planDocId, org)` must
   return the parent (else `plan_state_unavailable`).
3. Command signing: if the target requires a browser signature
   (`resolveLaunchCommandSigningRequirement` in `lib/loops/loop-desktop.ts`) the
   run fails with `signing_required`; unattended runs cannot sign.
4. `resolveLoopContext(artifact, {command, repo: agent.repository ?? undefined}, handler, ...)`;
   `requiresRepo` without a repo → `no_repository`.
5. Harness: `resolveLaunchHarness` (moved from the run-loop route to
   `lib/loops/launch-harness.ts` and exported; the route imports it).
6. `loopsService.create(org, runAsUserId, {command, harness, documentId,
   parentLoopId, computeTargetId, prompt: buildLoopPrompt(command,...), repo,
   additionalRepos, contextRefs, metadata: {workflowRunId}})`. A `BLOCKED`
   response is a failure (`document_blocked`); never dispatch it. Map
   `ConcurrentLoopLimitError`, `LoopAlreadyActiveError`,
   `RepoNotInProjectPoolError`, `UnauthorizedRepoError` to error codes.
7. Insert the `workflow_run_loops` row. For EXECUTE, record the run's
   repository (`engine/run-repository.ts`): the project repository whose full
   name matches the loop's repository, with the loop's base branch, or none.
   Then await `dispatchAndClassify(loopId, org, "workflow-engine", {workflowRunId})`.

Correlation never relies on `Loop.metadata` (several terminal writers replace
it); `workflow_run_loops` is the source of truth.

### Issue document body

```markdown
> Imported from {provider display name} [{key}]({url}) by workflow "{name}".

| Field | Value |
|---|---|
| Type | ... | Status | ... | Priority | ... | Labels | ... | Reporter | ... |

## Description
{bodyMarkdown}

## {section.title}            (one per SourceItem section, e.g. Acceptance Criteria)
{section.markdown}

## Comments                   (latest 20, oldest first)
**{author}** ({createdAt}): {bodyMarkdown}

## Attachments
- [{name}]({url})

## Additional instructions    (workflow agent.instructions, when set)
```

A **PRD** body is the import notice followed by the item's description as is
(the requirement keeps its own headings; no fields table, no "## Description"
wrapper), then the sections, comments, attachments and additional
instructions like an Issue.

Imported PRDs and Issues are wrapped as untrusted input by the loop context
pack, so ticket text cannot act as instructions to the agents. The body is capped at
100 000 characters.

## Actions

Pre actions: see the `pre_actions` step above. They block the agent team, run
in order, and their failure fails the run unless `continueOnError`.

Post actions: `enqueueRunEvent(run, event)` inserts one `workflow_action_runs` row per
enabled **post** action of the workflow subscribed to `event`
(`createMany` + `skipDuplicates` on `(runId, actionId, event, cycle)`), then
`waitUntil(drainActionRuns({runId}))`.

The drain only handles `stage = post` rows. It reads the due rows and claims
each one with an `updateManyAndReturn` from `pending` to `running` that
re-checks `nextAttemptAt <= now` and increments `attempts`; the attempt number
(`ctx.attempt`, the backoff and the attempt limit) is the value the claim
returned, never the earlier read. Rows of one run are executed in order; when
a row cannot be claimed (another drain holds it, or it was rescheduled since
the read) the drain leaves the rest of that run for a later drain, so
overlapping drains (the background drain after a transition and the tick)
never run one run's rows side by side or skip a backoff. The claimed row's
action and connection runtime are loaded, the config is parsed with the
action's `configSchema`, the `WorkflowRunSnapshot` is built, and
`action.execute(ctx)` is called:

- `succeeded` / `skipped` → final, `completedAt`, `externalRef`. A succeeded
  or failed result may carry `outputs`: each of `outputs.pullRequests` is
  recorded on its repository of the run, and the first becomes the run's pull
  request (`prUrl`, `branchName`; only when the run has none yet) before the
  row is settled, so the run's next actions see them as `{{pr.url}}` and
  `{{pr.urls}}`. A failed result reports what it did before failing (the
  pull requests opened before another repository failed).
- `failed` + retryable and `attempts < 5` → back to `pending` with
  `nextAttemptAt` after 30 s, 2 min, 10 min, 30 min.
- otherwise → `failed` with `lastError`.

Actions whose connection or action row was deleted, or whose config no longer
parses, are `skipped` with the reason. Rows stuck in `running` for more than
10 minutes (process died) go back to `pending`. Post actions never change the
run status. `ctx.actionRunId` (stable across retries) and `ctx.attempt` are
passed to every action, e.g. for idempotency keys.

`ctx.render(template)` renders `{{path}}` placeholders from
`WORKFLOW_TEMPLATE_VARIABLES` (`summary`, `run.url`, `source.key`,
`pr.url`, ...). Unknown names render empty; values are inserted verbatim (no
HTML escaping — providers escape for their own format). `summary` is a
ready-made markdown text per event, so the default template of every message
field is `{{summary}}`:

| Event | Summary |
|---|---|
| `run.triggered` | 🤖 AgentFlow received **{key}** ({title}) and is about to start working on it. Follow the run: {run.url} |
| `run.started` | 🤖 AgentFlow picked up **{key}** and started planning. Follow the run: {run.url} |
| `run.plan_ready` | 📝 The implementation plan for **{key}** is ready: {plan.url} + excerpt |
| `run.needs_input` | ❓ The plan for **{key}** has open questions that need an answer before implementation: list + {plan.url}. Answer them on the ticket and assign it to the bot again, or approve the plan in AgentFlow. A project process step instead: ❓ The "{step.name}" step for **{key}** has questions that need an answer: list + answer on the ticket or in AgentFlow ({run.url}); an approval step: 🛂 The "{step.name}" step for **{key}** waits for an approval in AgentFlow: {run.url}. `{{step.name}}` and `{{step.questions}}` (one per line) are empty on the built-in flow. |
| `run.succeeded` | ✅ **{key}** is done. Pull request: {pr.url} (branch {pr.branch}). Several pull requests: one line per repository. Plan mode: plan link instead. |
| `run.failed` | ⚠️ AgentFlow could not complete **{key}**: {error.message}. Details: {run.url} |

`{{repository.name}}`, `{{repository.url}}`, `{{repository.branch}}` (the branch
the agent team pushed) and `{{repository.baseBranch}}` describe the first of the
run's project repositories the agent team pushed to (else its first one) once
EXECUTE was launched. `{{pr.urls}}` lists every pull request of the run, one
per line.

Links: `run.url = {NEXT_PUBLIC_APP_URL}/{orgSlug}/workflows/{workflowId}/runs/{runId}`,
Issue `…/{orgSlug}/issues/{slug}`, plan `…/{orgSlug}/implementation-plans/{slug}`.

## Scheduler

Self-hosted has no Vercel cron. `apps/api/server.ts` starts
`startSelfHostedCronRunner({port})` after the server listens. It calls its own
cron routes over HTTP on `127.0.0.1` with `Authorization: Bearer
$CRON_SECRET` (so the work runs inside the Next.js route module graph, like
every other request), never overlapping a job with itself:

| Job | Interval |
|---|---|
| `GET /cron/workflows` | `WORKFLOW_TICK_SECONDS` (default 10 s) |
| `GET /cron/timeout-loops` | 5 min (existing reaper; also releases BLOCKED loops) |

If `CRON_SECRET` is unset the runner generates an ephemeral one for the
process. `SELF_HOSTED_CRON_DISABLED=true` turns the runner off (for example
when an external scheduler calls the cron routes).

One `/cron/workflows` tick: poll due connections → advance runs that are not
leased, not final and not waiting for a step retry (`nextStepAt` null or due;
oldest first, max 50; `planning`/`executing`/`needs_input` are cheap checks) →
requeue stale `running` action runs → drain due action runs (max 50). The tick
returns counts as JSON.

## API

All routes are org-scoped through the session (or API key). Mutations require
org admin/owner (`getOrgAdminStatus`), reads any member. Secrets are never
returned except the inbound secret on the admin-only inbound endpoint.

Reads by members who are not org admins hide outbound URLs, which often carry
a token in the path or query: `GET /integrations/connections[/{id}]` and
`GET /workflows[/{id}]` return every config field of kind `url` (connection
config, trigger config and action config, e.g. the `webhook.post` target) as
its origin only, e.g. `https://hooks.example.com/…`. A config whose provider or
type is no longer registered is returned empty to them. Admins get the full
values (the routes pass an explicit viewer flag from `getOrgAdminStatus`;
create/update responses are admin-only and always full).

| Method | Path | Body → Response |
|---|---|---|
| GET | `/integrations/providers` | → `IntegrationProvidersResponse` |
| GET | `/integrations/connections` | → `IntegrationConnectionsResponse` |
| POST | `/integrations/connections` | `CreateIntegrationConnectionInput` → `IntegrationConnection` (validated with the provider first; 400 with the provider message on failure) |
| GET | `/integrations/connections/{id}` | → `IntegrationConnection` |
| PATCH | `/integrations/connections/{id}` | `UpdateIntegrationConnectionInput` → `IntegrationConnection` (re-validates when config or secrets change; 400 "Re-enter … when changing …" when a credential origin field changes without the secrets, see below) |
| DELETE | `/integrations/connections/{id}` | → `{deleted: true}`; 409 while used by a workflow trigger, action or project repository |
| POST | `/integrations/connections/{id}/test` | → `IntegrationConnectionTestResult` |
| GET | `/integrations/connections/{id}/inbound` | → `IntegrationInboundDetails` |
| POST | `/integrations/connections/{id}/inbound/rotate` | → `IntegrationInboundDetails` (new key and secret) |
| GET | `/integrations/connections/{id}/deliveries` | → `IntegrationDeliveriesResponse` (latest 50) |
| GET | `/integrations/connections/{id}/repositories?query=&limit=` | → `IntegrationRepositoriesResponse` (admin; repositories the connection can access, ≤ 100; 400 when the provider has no repositories, 502 with the provider's message when it fails) |
| GET | `/projects/{id}/repositories` | → `ProjectRepositoriesResponse` (oldest first) |
| GET / PUT | `/projects/{id}/agent-instructions` | → `{instructions}`; PUT `{instructions}` (admin, max 32 000 characters; blank removes them) |
| POST | `/projects/{id}/repositories` | `AddProjectRepositoryInput` (`{connectionId, externalId, isPrimary?}`) → `ProjectRepository` (admin; the connection must offer repositories and see the repository; 409 when already added or at 20 repositories) |
| PATCH | `/projects/{id}/repositories/{repositoryId}` | `{isPrimary: true}` → `ProjectRepository` (admin) |
| DELETE | `/projects/{id}/repositories/{repositoryId}` | → `{deleted: true}` (admin; the oldest remaining repository becomes primary) |
| POST | `/webhooks/integrations/{inboundKey}` | public ingress |
| GET | `/workflows` | → `WorkflowsResponse` |
| POST | `/workflows` | `SaveWorkflowInput` → `Workflow` |
| GET | `/workflows/{id}` | → `Workflow` |
| PUT | `/workflows/{id}` | `SaveWorkflowInput` → `Workflow` |
| PATCH | `/workflows/{id}` | `SetWorkflowEnabledInput` (`{enabled}`) → `Workflow`. `false` always succeeds, without any dependency check; `true` re-validates the stored workflow as the caller (400 with the reason) |
| DELETE | `/workflows/{id}` | → `{deleted: true}` |
| GET | `/workflows/{id}/runs?cursor=&limit=` | → `WorkflowRunsResponse` |
| POST | `/workflows/{id}/runs` | `StartWorkflowRunInput` → `WorkflowRunSummary` |
| GET | `/workflow-runs?cursor=&limit=&status=` | → `WorkflowRunsResponse` (all workflows) |
| GET | `/workflow-runs/{runId}` | → `WorkflowRunDetail` |
| POST | `/workflow-runs/{runId}/cancel` | → `WorkflowRunDetail` (cancels active loops) |
| POST | `/workflow-runs/{runId}/answers` | `{answers: [{id, answer}]}` → `WorkflowRunDetail` (any org member; the run must be `needs_input` on an agent step's questions not yet answered; 409 otherwise, 400 for an unknown or repeated question id) |
| POST | `/workflow-runs/{runId}/approval` | `{approved, comment?}` → `WorkflowRunDetail` (admin; the run must be `needs_approval` and undecided; 409 otherwise) |
| GET / PUT | `/projects/{id}/process` | → `ProjectProcessState` (`current: null` = the built-in flow); PUT `{process}` saves a new version, `null` goes back to the built-in flow (admin; the toolkit must be one of the project's repositories, 400 otherwise) |
| GET | `/projects/{id}/process/versions` | → `ProjectProcessVersions` (newest first, ≤ 50) |
| POST | `/workflow-runs/{runId}/action-runs/{actionRunId}/retry` | → `WorkflowRunDetail` |
| GET | `/cron/workflows` | `Bearer CRON_SECRET` → tick counts |

Saving a workflow validates every trigger and action against the registry:
the connection exists in the org, the type belongs to the connection's
provider, and the config parses with the definition's schema (the parsed
config is stored). A **disabled** connection is accepted: it ignores inbound
events and its actions are skipped at run time, so disabling a connection
never blocks saving (or turning off) the workflows that use it. Pre actions
store `events = [run.triggered]`; post actions need at least one event and may
not use `run.triggered`. The order of actions in the request is their
position within each stage, and error messages name actions the way the
editor does: "Pre action 2: …", "Post action 1: …" (1-based within the
stage); triggers are "Trigger 1: …". On update, an omitted `runAsUserId`
keeps the stored run-as user. The project must exist in the org and the
run-as user must be an active org member.

**Compute target rule.** When the caller runs the workflow as themselves
(effective `runAsUserId` = caller), the compute target must be owned by them
or shared with the org. When the workflow runs as another member, the target
must be shared with the org (`isSharedWithOrg = true`): an admin can never
send agent loops to another member's private desktop, because sharing a
desktop is its owner's opt-in to other people's work. The rule is checked
against the admin making the change on create, on update (including an update
that keeps the stored run-as user) and when turning a workflow on with
`PATCH /workflows/{id}`.

**Turning a workflow on and off.** `PATCH /workflows/{id} {enabled}` changes
only the flag. Turning it off never checks anything, so a workflow whose
run-as user left, whose compute target was removed or whose connection broke
can always be paused. Turning it on runs the full save validation on the
stored workflow as the caller and answers 400 with the first problem.

**Credential origin rule.** A provider lists the connection config fields
that decide where its credentials are sent (`connection.credentialOriginFields`;
Jira: `siteUrl`, `deployment`; Azure DevOps: `organizationUrl`). When a
`PATCH /integrations/connections/{id}` changes one of them (compared as parsed
by the provider's config schema), every secret field that is currently set
must be submitted again, non-empty, in the same request; otherwise the update
is refused with 400 "Re-enter <secret labels> when changing <field labels>."
before the provider is called, so a stored token is never sent to a host it
was not entered for. While the origin is unchanged, stored secrets are reused
as before.

## Providers

### Jira (`jira`)

Connection: `deployment` (`cloud` | `data_center`), `siteUrl`, `email`
(cloud), secret `apiToken` (cloud: API token used with Basic `email:token`;
data center: personal access token used as Bearer). `validate` calls
`/rest/api/{3|2}/myself`; the returned account (accountId, or name/key on
Data Center) is the **bot**. Delivery: webhook or poll. Credential origin
fields: `siteUrl`, `deployment` (changing either requires the token again).

Triggers:
- `jira.issue_assigned` — issue created with, or changed to, the bot as
  assignee (`changelog.items[].fieldId == "assignee"`, prefer
  `tmpToAccountId`). Filters: project keys, issue types, labels (any).
  `dedupKey = {issueKey}:assignee:{changelogId}` (`{issueKey}:created` on
  creation). Manual run with an issue key.
- `jira.issue_labeled` — a configured label added (`fieldId == "labels"`).
- `jira.issue_mentioned` — a comment (`comment_created` / `comment_updated`
  webhooks) or the description (on creation, or edited to newly mention it)
  mentions the bot: `[~accountid:…]` / `[~username]` wiki markup or ADF
  mention nodes. `dedupKey = {key}:mention:comment-{commentId}` or
  `{key}:mention:{changelogId}`. Webhook delivery only (Jira search cannot
  find mentions); select the Comment events on the admin webhook.

Webhook bodies come from admin webhooks or from a Jira Automation "Send web
request" rule with the "Work item data (Jira format)" body (its numeric
epoch-millisecond dates are accepted; non-essential fields never reject a
delivery). Changing `siteUrl` or `deployment` requires re-entering the API
token. Rate limits, 5xx and timeouts while loading the issue raise
`RetryableSourceError`, so the import is retried.

Events caused by the bot itself are dropped (loop prevention). Poll uses JQL
(`assignee = <bot>` / `labels = <label>` with `updated >= cursor - 1m`,
`expand=changelog`). The item is re-fetched with
`expand=renderedFields`; HTML is converted to markdown.

Actions: `jira.add_comment` (markdown → ADF on Cloud, plain text/wiki on
Data Center; target the source issue), `jira.transition_issue` (transition by
name, e.g. "In Review"). Both skip when the run's source is not a Jira item.

### Azure DevOps (`azure_devops`)

Connection: `organizationUrl` (`https://dev.azure.com/{org}`), secret `pat`
(organization-scoped; Basic `:pat`). `validate` calls
`{org}/_apis/connectionData`; the authenticated user is the bot (id +
uniqueName/email aliases). Credential origin field: `organizationUrl`. Delivery: webhook (service hooks
`workitem.created` / `workitem.updated`, with the `X-AgentFlow-Token` header
or Basic auth) or poll (WIQL `[System.AssignedTo] = @Me AND
[System.ChangedDate] >= …` + work item updates).

Triggers: `azure_devops.work_item_assigned` (filters: projects, work item
types, area path prefix, tags; `dedupKey = {id}:rev:{rev}`; manual run with a
work item id), `azure_devops.work_item_tagged`,
`azure_devops.work_item_mentioned` (a comment, or the description of a new
work item, mentions the bot: `data-vss-mention="version:2.0,{bot identity id}"`;
`dedupKey = {id}:mention:{rev}`; webhook: also subscribe **Work item
commented on** (`workitem.commented`); poll: WIQL `[System.Id] IN
(@RecentMentions)`, best effort).

Actions: `azure_devops.add_comment` (markdown comment),
`azure_devops.update_state`, `azure_devops.create_pull_request` (see
"Project repositories"), `azure_devops.run_pipeline` (queues an Azure
Pipelines run: pipeline id, project (default: the run repository's project,
else the work item's) and branch (default: the branch the agent team pushed);
retried only on 429/503, so a retry never queues a second run).

Repositories: Azure Repos Git repositories of the organization
(`_apis/git/repositories`), full name `{organization}/{project}/{repo}`;
the clone URL drops the user name ADO embeds. Git credential: the PAT with a
placeholder user name. Pull requests reuse the active pull request of the same
source and target branch. Scopes: Work Items (Read & write), plus Code (Read &
write) for repositories and pull requests and Build (Read & execute) for
pipelines.

### GitHub (`github`)

Connection: secret `token`, a **fine-grained personal access token** of the
bot account with access to the repositories projects will use and the
Contents and Pull requests permissions set to Read and write, and config
`apiUrl` (default `https://api.github.com`; `https://{host}/api/v3` for
GitHub Enterprise Server; credential origin field). `validate` calls
`GET /user`; the token owner is the bot. No inbound side and no triggers yet.

Repositories: `GET /user/repos` (paged, at most 1000), archived repositories
left out; `externalId` is the numeric repository id. Git credential:
`x-access-token` + the token. Action `github.create_pull_request` reuses the
open pull request of the same head and base branch (also after a 422 race).
Rate limits (429, or 403 with `x-ratelimit-remaining: 0`) are retryable.

### Bitbucket (`bitbucket`)

Bitbucket Cloud only (Data Center has another API). Connection: secret
`token`, an **Atlassian API token with scopes** of the bot account (app:
Bitbucket; scopes `read:user`, `read:workspace`, `read:repository`,
`write:repository`, `read:pullrequest`, `write:pullrequest`, each
`:bitbucket`) or a workspace, project or repository access token (Repositories
and Pull requests: Write); app passwords no longer exist. Config `workspace`
(optional; required for access tokens) and `apiUrl` (not on the form:
`https://api.bitbucket.org/2.0`, or a local host in tests); both are credential
origin fields. The token is sent as `Authorization: Bearer` and redirects are
not followed. `validate` reads the workspace's repositories when one is set,
then `GET /user` (the token's account is the bot; an access token has none and
is named after its workspace).

Repositories: the connection's workspace, else every workspace of the
account (`GET /user/workspaces`, then `GET /repositories/{workspace}?role=member`;
Bitbucket removed the cross-workspace listing), filtered with
`full_name ~ "…"`, at most 15 requests; `next` links are only followed below
the API URL. `externalId` is `{workspace uuid}/{repository uuid}` (renames
keep it); the clone URL is the HTTPS clone link without its user name. Git
credential: `x-token-auth` + the token. Action `bitbucket.create_pull_request`
reuses the open pull request of the same source and destination branch (also
after a 400 race); draft is sent only when set. 429 is retryable.

### Local Git (`local_git`)

Git hosting on the team's own machine for projects without a remote: the
`local-git` service of `docker-compose.yml` (Gitea, MIT), with a web UI to
browse code, commits and branches, review and merge pull requests and download
archives. Setup in [local-git.md](local-git.md). Connection: secret `token` (a
Gitea access token with `write:repository`, `write:organization`,
`write:user`, `write:issue`; `pnpm local-git:init` creates the account and the
token), config `serverUrl` (where the API reaches it, default
`http://localhost:3300`), `runnerUrl` (where runners reach it when that
differs, e.g. `http://host.docker.internal:3300`; empty = `serverUrl`) and
`owner` (user or organization: only its repositories are offered and new ones
are created there; empty = every repository the token sees, new ones in the
token's account). `serverUrl` and `runnerUrl` are credential origin fields.
The token is sent as `Authorization: token …`; redirects are not followed.
`validate` calls `GET /api/v1/user` and checks that the owner exists.

Repositories: `GET /api/v1/repos/search` (alphabetical, 5 pages of 50; with an
owner `uid` + `exclusive`); `externalId` is Gitea's numeric repository id; the
clone URL is Gitea's with the runner URL's scheme and host. Git credential:
`agentflow` + the token. `create` (capability `repository_creation`, `POST
/integrations/connections/{id}/repositories`, admins) makes a private
repository with a first commit on `main`, in the owner organization or the
token's account. Action `local_git.create_pull_request` reuses the open pull
request of the same branches (`GET /repos/{owner}/{repo}/pulls/{base}/{head}`,
also after a 409 race); a draft gets Gitea's `WIP: ` title prefix. No inbound
side: merging in Local Git is not reported back to AgentFlow.

### Microsoft Teams (`microsoft_teams`)

Connection: secret `webhookUrl` — a Teams **Workflows** webhook ("When a
Teams webhook request is received", *Send webhook alerts to a channel*
template). Office 365 connector webhooks were retired in 2026 and are rejected.
`validate("test")` posts a test card.

Action: `microsoft_teams.post_message` — Adaptive Card 1.4 with title,
markdown text, facts (status, source, PR) and "Open …" buttons.

### Webhook (`webhook`)

Built in, not an integration: it is not offered in Settings → Connections.
Every workflow can use it as its **HTTP request** trigger (source "HTTP
request (this workflow's URL)") and as an **HTTPS request** pre/post action
(source "HTTPS request (built-in)"). Saving the workflow creates one webhook
connection owned by it (`integration_connections.managed_by_workflow_id`;
`connectionId: null` in `SaveWorkflowInput`), shown in the editor as "Show
URL and secret", removed when no trigger or action uses it and deleted with
the workflow. Another workflow cannot reference it. Webhook connections
created through the API before keep working.

Generic HTTPS in both directions. Connection: optional secrets
`callbackUrl` (default target of outbound calls; sealed like a secret because
receivers such as Zapier or n8n embed their credential in the URL) and
`signingSecret`, and config `allowedCallbackHosts` (hosts a request's
`callbackUrl` may point to). Inbound secret format `whsec_…`.

Trigger `webhook.request` — body:

`callbackUrl` and `metadata` are kept as `InboundEvent.extras` and reach
actions as `run.sourceExtras`.

```json
{ "id": "evt-1", "title": "Add CSV export", "description": "markdown", "key": "REQ-7",
  "url": "https://...", "type": "feature", "labels": ["x"], "callbackUrl": "https://..." }
```

`"type": "prd"` (or "Product Requirements Document") imports the item as a
PRD instead of an Issue: the description is the PRD's body and the plan is
generated from it.

`dedupKey = body.id ?? webhook-id header`. The item is carried inline (no
fetch). Filter: `types`.

Action `webhook.post` — POSTs `{type: event, run: WorkflowRunSnapshot}`,
signed with Standard Webhooks headers when `signingSecret` is set, to the
first of: the request's `callbackUrl` (when the action's `useSourceCallback`
option is on and the host is in `allowedCallbackHosts`, or, with no list, is
not a local or private address), the action URL, the connection
`callbackUrl`. A refused request callback falls back to the admin's URLs and
is noted on the action run. Outbound calls never follow redirects (a 3xx is a
failed delivery).

## Project repositories

Project → Repositories (a tab on the project page) lists the project's
repositories and adds new ones: pick a connection whose provider has the
`repositories` capability, search the repositories it can access, add.
Adding and removing repositories are org-admin
operations, because agents push to these repositories with the connection's
credentials. A repository stores no token. Deleting its connection is refused
while a project uses it; a repository whose connection is gone shows
"Connection removed".

Pull requests are **workflow actions**, never implicit: add "Create pull
request" (`github.create_pull_request`, `azure_devops.create_pull_request`)
as a post action on `run.succeeded`, on the connection that owns the
project repositories. It opens one pull request in **each** repository of the
run that its connection owns and that the agent team pushed a branch to
(`run.repositories[].branch`; a repository without changes has none), from
that branch into the configured target branch, else the branch the run
started from, else the repository's default branch. Title and description are
templates (defaults `{{source.key}}: {{source.title}}` and a "Resolves …"
text). A project with repositories on two providers needs the action of each
connection. It skips when the run has no repository, none belongs to its
connection, nothing was pushed, or every pushed repository already has a pull
request. It fails (retryable when any failure is) when a repository's pull
request could not be opened; the ones it opened are still reported, and a
retry finds them already open. It reports them as `outputs.pullRequests`, so
post actions after it (e.g. a Jira comment with `{{pr.url}}` or
`{{pr.urls}}`) link them.

### How loops use them

A loop on a document of a project with project repositories works in all of
those repositories, as equals (`apps/api/app/projects/project-repository-checkouts.ts`):

- **Agent instructions.** Project → Overview holds the project's agent
  instructions (`PUT /projects/{id}/agent-instructions`, org admins; stored
  as `agentInstructions` in the project's `settings`). They are project-wide
  context, not only about repositories: the project's goal, domain terms,
  conventions and rules, and what each repository does and how they work
  together. Each repository keeps its own `CLAUDE.md` / `AGENTS.md` for its
  conventions.
- **Workspace.** The computer builds one folder per loop key,
  `<workspace>/loops/<slug>`: every repository's loop worktree is a
  subdirectory (`<slug>/<repo name>`), and the folder's `CLAUDE.md` holds the
  agent instructions and the list of repositories. The agent (Claude Code)
  runs from that folder, so the folder's `CLAUDE.md` is loaded first and a
  repository's own `CLAUDE.md` when the agent works in it; the `AGENTS.md` of
  a repository without a `CLAUDE.md` is imported from the folder's `CLAUDE.md`
  (Claude Code does not load a nested `AGENTS.md`). The folder is not a
  repository, so nothing written there is ever committed. The work directory
  (`.agentflow-ai/work`: PRD, plan, state) is at the folder root; PLAN
  starts it fresh, EXECUTE reuses it (`apps/desktop/src/server/operations/loop-workspace.ts`).
- **Selection.** Every project repository goes into the loop
  (`repo` is just the first one, where the loop's branch is recorded): a
  project has at most `PROJECT_REPOSITORIES_MAX` (20) repositories and
  `MAX_ADDITIONAL_REPOS` follows it (19). The GitHub App team pool is only the
  fallback for projects without project repositories, and a loop on a
  project with them may only name those repositories
  (`app/loops/authorize-loop-repositories.ts`).
- **Checkout.** The loop body carries each repository's `cloneUrl`. The
  computer clones it into `<workspace>/<host>/<owner>__<repo>` (fetches an
  existing checkout, and adds `.agentflow-ai/` to its `.git/info/exclude`),
  then creates the loop worktrees from those checkouts. Loops sharing a
  repository (two issues of a project, or two projects) share its checkout;
  the clone or fetch and the worktree creation take the checkout's lock, so
  they never run at the same time (`loop-repo-checkout.ts`). Each loop then
  works in its own worktree on its own branch. Branch materialization
  (GitHub `owner/repo` origin checks) is not used; the first repository's
  branch is `symphony/<slug>`.
- **Credentials.** The computer stores no repository token. Git runs with a
  credential helper set through `GIT_CONFIG_*` environment variables that
  posts git's credential request to `POST /loops/{id}/git-credential` with
  the loop's runner token; the API answers with the connection's credential
  for that loop's repositories only, and refuses once the loop has finished
  (`apps/api/lib/loops/loop-git-credential.ts`,
  `apps/desktop/src/server/operations/loop-git-access.ts`).
- **Runners.** Project → Repositories → Runners lists the computers the
  project's loops run on (`settings.runnerIds`, `GET/PUT
  /projects/{id}/runners`, org admins). Every runner of a project needs the
  toolchains of all its repositories; headless runners report the ones they
  find (`toolchains` capability: node, dotnet, cargo, java, ...), shown on
  each runner. A new loop on a project with runners always runs on one of
  them: the computer the user or the workflow asked for when it is a runner,
  else the online runner with the most free capacity (active loops against
  `maxInFlightCommands`), else the run fails with "none of the project's
  runners is online". A loop that continues another (EXECUTE) stays on the
  runner holding its state. A project without runners runs on the computer
  the user or the workflow picks (`app/projects/project-runner-selection.ts`).
- **Bootstrap.** The agent-bootstrap preflight (generated expert agents) is
  skipped for workspace loops: it writes into each repository, where an
  agent running from the workspace root never loads it.
- **EXECUTE** commits each repository's changes (without `.claude/` and
  `.agentflow-ai/`) and pushes its branch; it opens no pull request. The
  execution result reports `status: "pushed"` (or `skipped`, no changes) per
  repository. The run records all of the loop's repositories when EXECUTE is
  launched (`WorkflowRun.repository`, a list) and, when EXECUTE completes,
  the branch each one was pushed to; the run's "Create pull request" actions
  then open a pull request per pushed repository. A loop run outside a
  workflow therefore ends with pushed branches and no pull request.

Limits: a computer restarted between the agent
exiting and the push retries finalization without the per-loop credentials.
The runner's own `git-credential` requests use the loop token, which lasts
8 hours.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_WEBHOOK_BASE_URL` | `NEXT_PUBLIC_API_URL` | Public origin of the API shown in inbound URLs |
| `WORKFLOW_TICK_SECONDS` | `10` | Scheduler tick for workflows |
| `WORKFLOW_RUN_PHASE_TIMEOUT_HOURS` | `24` | Fail runs stuck in planning/executing |
| `CRON_SECRET` | ephemeral | Bearer for `/cron/*` |
| `SELF_HOSTED_CRON_DISABLED` | unset | `true` disables the in-process runner |
| `NEXT_PUBLIC_APP_URL` | — | Base of links in post actions |

## Security notes

- Inbound requests are authenticated per connection (HMAC, Standard Webhooks
  or a static token), compared in constant time, with a body cap. Deliveries
  are de-duplicated in the database.
- Webhook payloads are hints: items are re-fetched with the connection
  credentials before use.
- Ticket text is untrusted: it lands only in the Issue document, which the
  loop context pack wraps as untrusted input.
- Credentials are sealed with AES-256-GCM under dedicated purposes
  (`integration-credentials`, `integration-inbound-secret`); the API returns
  only `isSet` + last four characters. Stored credentials are only reused
  while the provider's credential origin fields (e.g. the Jira site URL) keep
  their value; changing one requires entering the secrets again.
- Members who are not org admins see url-kind config values (outbound webhook
  targets, callback URLs) as their origin only.
- Connection and workflow changes, project repository changes, manual runs,
  cancel and retry require org admin. Listing a connection's repositories is
  admin-only too (it uses the connection's token). Loops run as the workflow's run-as user on a compute target that user
  can access; a workflow that runs as someone other than the admin who saved
  or enabled it may only use a target shared with the org.
- Bot loop prevention: providers drop events caused by the bot account.
