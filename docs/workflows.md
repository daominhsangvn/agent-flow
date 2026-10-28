# Workflows and integrations

Event-driven automation for the self-hosted edition. The admin defines the
whole flow of a **workflow**:

```
trigger(s)  ->  import  ->  actions on          ->  agent team      ->  actions on later events
                            workflow.triggered      (PLAN, optional     (workflow.started,
                            (in order, before       EXECUTE -> PR)       plan.started/completed,
                             the agent team)                             input.needed,
                                                                         execute.started/completed,
                                                                         workflow.completed/failed)
```

- **Triggers** come from external systems: a Jira issue assigned to the bot,
  an Azure DevOps work item assigned to the bot, a signed HTTPS request, ...
- **Actions** form one ordered list; each runs `on` run events. Those on
  `workflow.triggered` (pre actions) run once the item is imported, one after
  another, before the agent team starts: e.g. move the Jira issue to
  "In Progress". A failed one stops the run unless it is marked
  `continueOnError`. The others (post actions) run on later events: comment
  a summary on the ticket when the implementation is done, transition it to
  "In Review", post to Teams, call an HTTPS endpoint, ...
- An action is an **instruction** in plain language ("Move the issue to In
  Progress", "Summarize what was implemented and comment on the issue"),
  which an agent carries out reading the run's plan folder, or a **type**
  with its config (`jira.add_comment`, `local_git.create_pull_request`, ...).
- The **agent team** imports the item (as a **PRD** when the run's computer,
  reading the workflow's PRD instruction `agent.prd.instruction`, decides it
  is a product requirement; as an **Issue** otherwise, and always without an
  instruction) and runs on a desktop compute target: PLAN, then optionally EXECUTE, which pushes a branch to every
  project repository it changed; a create pull request action then opens one
  pull request per pushed repository.

**The engine never writes to a source system on its own.** Receiving a
webhook, polling and importing the item only read. Every change in Jira,
Azure DevOps, Teams or anywhere else is an action the admin added
to the workflow. (The engine does update AgentFlow's own documents: it
approves the plan before EXECUTE and moves the imported Issue to in review, or
marks the imported PRD executed.)

Real use case: a BA writes a requirement in Jira and assigns it to the bot
account → the workflow whose Jira trigger matches starts a run → an
instruction on `workflow.triggered` moves the issue to "In Progress" → the
agent team plans and implements it → a pull request action on
`workflow.completed`, and an instruction on `execute.completed` comments a
summary of the work (with the PR link) on the issue and moves it to "In
Review".

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
| Project connection | `project_connections`, `project_connection_scopes` | A project's use of an organization connection under a `key` (slug, unique per project, never changes): what workflow and process YAML name. `settings` narrow what the project works on (Jira `projectKeys`, Azure DevOps `projects`); each such container belongs to one project (scope `<provider>:<origin>:<container>`), whose project connections may share it, one connection each ("One bot per workflow"). The account is always the connection's: an organization connection is one account (one Jira bot) and is added to a project at most once. Org admins only (Project → Integrations). |
| Delivery | `integration_deliveries` | A verified inbound event batch (webhook request, poll result, manual run). Unique per `(connection, deliveryId)`, so provider retries are absorbed. |
| Workflow | `workflows` | Name, project, run-as user, agent config, ≥1 trigger, ≥0 actions. |
| Trigger | `workflow_triggers` | `(project, project connection, type, config)`; the built-in HTTP endpoint has no project connection. `type` is a provider trigger key such as `jira.issue_assigned`. A workflow may have several triggers on different connections. |
| Action | `workflow_actions` | `(connection key?, type, config, stage, events[], continueOnError, position)`; the key is resolved in the run's project. `type` is a provider action key such as `jira.add_comment`, or `agentflow.instruction` (`config.instruction`, carried out by an agent: "Actions" below). Stage `pre`: runs on `workflow.triggered`, in order, before the agent team. Stage `post`: runs on the subscribed run events. `position` is the action's place in the workflow's one action list. No key: the run chooses the connection ("Actions" below); `connection_id` is set only for the workflow's built-in HTTPS call. |
| Project repository | `project_repositories` | A repository a project works on, added from a connection whose provider has the `repositories` capability (GitHub, Azure DevOps, Bitbucket, Local Git); with the `repository_creation` capability (Local Git) the project can also create a new one. Stores only the provider's id, name, URLs and default branch; no token. All of a project's repositories are equal to its agents; the first one only anchors the loop's branch record. |
| Run | `workflow_runs` | One execution for one source item occurrence, in its trigger's project, from its source project connection (`project_connection_id`). Owns the imported PRD or Issue, the plan document and the loops. `repository` is the project repository EXECUTE works in (`RunRepositorySnapshot`). |
| Run loop | `workflow_run_loops` | Loops that belong to a run (launched by the engine, or adopted). |
| Action run | `workflow_action_runs` | One execution of an action for a run event, retried with backoff. Unique per `(run, action, event, cycle)`. Pre rows are executed by the run state machine, post rows by the outbox drain; a run's rows go strictly in order. An instruction's row is `waiting` while its agent works (`command_id`: the desktop command) and keeps what the agent did in `detail` (`WorkflowInstructionRunDetail`). |

Shared wire contracts: `packages/api/src/types/integration.ts` and
`packages/api/src/types/workflow.ts`.

## Project connections and how a connection is chosen

Workflows never name organization connections. An org admin adds them to a
project (Project → Integrations, `POST /projects/{id}/connections`) under a
key; the YAML names that key. Three rules decide every connection a run uses
(`engine/action-connection.ts`, `engine/instruction-action.ts`):

1. **Source pinning.** A run records its source project connection. An action
   on the source item (`target: source_item`: Jira comment/transition, ADO
   comment/state) always works on it; it has no item parameter, so an item key
   in the ticket text can never redirect it. With a `connection:` key it only
   runs for runs from that connection, and is skipped for others (never
   re-routed).
2. **Agents read unless granted.** An instruction (and a process agent step)
   reads the run's source item. Every write is listed in its `connections:`
   map (`packages/api/src/types/connection-grants.ts`): `source: [comment,
   transition]` on the source item, `<key>: [operation types]` or `<key>:
   read` on another project connection, `{ allow, with, approval }` to fix
   options. The API refuses any other operation.
3. **Choose only within what is named.** A typed action without `connection`
   works on the source (source item actions), on every connection holding a
   pushed repository (pull requests), or on the project's only connection
   offering the type; with several, saving asks for a key.

Every item routes through `project_connection_scopes`: a delivery arrives on
an organization connection (its webhook URL or its poll) and goes to the
project connection **of that connection** that claims the item's container;
an item no project connection of the connection claims is ignored. Events
are heard with the connection's account (a change made by its bot is
ignored, a mention or an assignment is of its bot). Manual runs refuse items
outside the trigger's project connection.

### One bot per workflow

An organization connection is one account. For one Jira bot per workflow
(BA, Dev, QC), an admin adds one Jira connection per bot (same site, each
with its own email and API token) in Settings → Integrations, then adds them
to the project together (Project → Integrations → Add connection, several
checked) with the same Jira project keys, each under its own key
(`jira-ba`, `jira-dev`, `jira-qc`). Each workflow's trigger names its key.
Another project claiming the same Jira projects is still refused (409).

- Each connection has its own webhook URL: configure one Jira webhook per bot
  (a JQL filter such as `project = ABC` keeps it to the project), or use poll
  mode (assignments only). Each delivery is heard by that connection's bot
  alone.
- A label one workflow's bot adds starts another workflow's run: only the bot
  that made the change ignores it (cross-workflow chaining, e.g. BA adds
  `ready-for-dev` and `ready-for-qc`). Two workflows that label each other in
  a cycle keep starting runs; give each direction a label nobody else adds.
- A comment by another workflow's bot is feedback for a run (only the run's
  own bot's comments are left out), and a mention reaches the bot named.
- Every bot needs access to the Jira project (Browse, comment, attachments
  for evidence).

## Workflow configuration (YAML)

A workflow is configured as YAML in the web editor (Workflows → New workflow,
or a workflow's **Configuration** tab), in a CodeMirror editor with
suggestions and inline problems
(`packages/app/workflows/components/workflow-editor.tsx`,
`workflow-yaml-editor.tsx`). Members see the same YAML read-only.

```yaml
name: Implement Jira requirements
description: BA assigns to the bot     # optional
enabled: true                          # optional, default true
project: Web shop                      # project name or id: the runs' project
triggers:                              # 1-10
  - connection: jira-shop              # a project connection key; http = the workflow's own URL
    project: Web shop                  # optional: the trigger's own project (its keys)
    type: jira.issue_assigned          # a trigger type of that connection's provider
    enabled: true                      # optional
    config:                            # the type's options
      projectKeys: [PROJ]
      labels: [ai-ready]
agent:
  runAs: ada@acme.dev                  # optional: user email, name or id
  runner: runner-1                     # runner (compute target) name or id
  runners:                             # optional runner rules, first match wins
    - runner: an-PRO-1                 #   e.g. the assignee's personal runner
      condition: source.assignee_email == "an@acme.dev"
  mode: plan_and_execute               # plan | plan_and_execute | orchestrated
                                       # orchestrated: runner = the orchestrator's runner,
                                       # instructions = its rules (docs/orchestrator.md)
  orchestrator:                        # orchestrated mode only
    concurrency: supersede             # supersede | queue
    debounceSeconds: 20                # quiet time before a turn, 0-600
    turnTimeoutMinutes: 10             # one turn's limit
  stopOnOpenQuestions: true
  repository:                          # optional override from the team pool
    fullName: acme/web
    branch: main
  prd:                                 # optional: which items are imported as a PRD
    instruction: PRD when the type is Feature or User Story and it has the label PRD.
  titleTemplate: "{{source.key}}: {{source.title}}"
  instructions: |                      # optional, appended to every imported item
    Use pnpm.
  process:                             # optional: the workflow's own process,
    steps: [...]                       #   written like Project → Process
actions:                               # optional; one list, run in order
  - on: workflow.triggered             # before the agent team; stands alone
    type: jira.transition_issue        # on the run's source item: no connection needed
    continueOnError: true              # optional, workflow.triggered only
    config:
      transitionName: In Progress
  - on: workflow.completed             # a run event, or a list of them
    type: local_git.create_pull_request  # a type: no connection = chosen by the run
    config:
      title: "{{source.key}}: {{source.title}}"
  - on: execute.completed
    instruction: |                     # {{variables}} work in instructions too
      Summarize what was implemented (changed files, tests, PR link)
      and post it as a comment on the issue.
    connections:                       # what the agent may write; read-only without
      source: [comment]                #   comment / transition on the run's source item
  - on: input.needed                   # questions to answer, an approval to give
    type: agentflow.email              # sent by AgentFlow itself: no connection
    config:
      to: [ada@acme.dev]               # subject: / body: optional templates
  - on: [workflow.failed]
    connection: http                   # http = a plain HTTPS call
    type: webhook.post
    config:
      url: https://example.com/hook
```

- **Actions.** Each item has `on` (one run event or a list:
  `workflow.triggered`, `workflow.started`, `plan.started`, `plan.completed`,
  `input.needed`, `execute.started`, `execute.completed`,
  `workflow.completed`, `workflow.failed`) and either an `instruction` or a
  `type` with its `config`. `workflow.triggered` cannot be combined with
  other events, and only its actions take `continueOnError`. An
  `agentflow.email` is sent through the server's mail relay and names no
  connection (see "Email"). `connection` (a project connection key) is
  optional: an instruction and an action on the source item (a comment, a
  transition) then work on the run's source project connection; a repository
  action (`*.create_pull_request`) on every connection that holds one of the
  run's repositories, so each repository the agent team pushed gets its pull
  request; any other type on the project's only connection that offers it.
  Saving fails when none will, or when several connections of a trigger's
  project offer the type (name one with `connection:`; see "Connection chosen
  by the run"). The old `run.*` event names (`run.triggered`, `run.started`,
  `run.plan_ready`, `run.needs_input`, `run.succeeded`, `run.failed`) and
  the older `preActions:` / `postActions:` lists (with `events:`) still read,
  with a warning; the editor writes `actions:`.

- **Names, not ids.** Connections, projects and runners are written by name
  (an exact match first, then ignoring case) and the run-as user by email; an
  id works too and is required when several entries share the name. A saved
  workflow opens with names, and keeps an id only where the name is unknown or
  shared. `connection: http` is the built-in webhook (the workflow's own
  inbound URL as a trigger, a plain HTTPS call as an action).
- **Suggestions** (`packages/app/workflows/lib/workflow-yaml-completions.ts`):
  the keys that fit at the cursor; on a new `- ` item of `triggers` or
  `actions` one snippet per connection and type (with the type's required
  options), and for `actions` two instructions first; connection names;
  the run events of `on:`; the types of the item's
  connection; the options of the item's type and their allowed values;
  projects, runners (online or offline), members, modes, run events and, after
  `{{`, the template variables. Inside `agent.process` the project process
  editor's own suggestions apply. Ctrl+Space shows them anywhere; a new line,
  a fresh `- ` and a `key: ` open them on their own.
- **Problems** (`packages/app/workflows/lib/workflow-yaml.ts`) are underlined
  as you type and listed by line after a save attempt: YAML syntax, the shape
  (`workflow-yaml-schema.ts`), names that do not resolve (listing the ones that
  exist), a type the connection's provider does not offer, options checked
  against the type's field descriptors (`integrations/lib/integration-yaml-fields.ts`: kinds,
  select options, required fields, URL and email formats), the nested process
  against the project process schema, and unknown keys as warnings naming the
  closest key. An offline runner is a warning. Errors block the save; the API
  validates the result again.
- **Configuration guide**
  (`packages/app/workflows/components/workflow-configuration-guide.tsx`),
  above the editor, open on a new workflow: how a run goes and every key of
  the workflow, a trigger, `agent`, `agent.repository` and `agent.prd` (with
  defaults and limits); the run events and when each fires; the keys of an
  action, how an instruction runs, which connection an action without one
  works on, and the order; the process (`agent.process` or the project's):
  how steps run and which events they report, every step type with its keys
  (`PROCESS_YAML_KEY_DOCS` of the process editor), the document and toolkit
  keys and a step instruction's `{{issue.*}}` variables; the org's
  connections with every trigger and action type and its options, read from
  the provider catalog so it lists exactly what the YAML can name (a
  repository action is marked "every pushed repository"); the template
  variables with when each has a value (`WORKFLOW_TEMPLATE_VARIABLES`
  `available`); and examples to copy. Its texts live in
  `workflow-yaml-docs.ts`, which the suggestions use too.
- **Actions in run order** (`workflow-actions-preview.tsx`), below the
  editor, read back from what a save would send: per run event in lifecycle
  order, the actions in list order with what each is (an instruction's first
  line, or the type) and the connection it works on, including the one the
  run will choose when the action names none.
- **PRD or Issue** (`agent.prd.instruction`, `workflowPrdRuleSchema`;
  `engine/source-classification.ts`). Without an instruction every item is
  imported as an Issue. With one, the run's computer decides once per run,
  before the run's documents are made: a **workflow decision** (desktop
  command `workflow_decision`, `POST /api/gateway/workflow-actions/decision`,
  unsigned like an instruction; `apps/desktop/.../workflow-decision.ts`) runs
  Claude Code without tools (every tool denied, an empty
  `--strict-mcp-config`, at most 3 turns, in its own folder
  `<allowed dir>/.agentflow-ai/decisions/<run id>`) on a prompt holding the
  instruction and the item (type, labels, status, priority, title,
  description and sections, as untrusted data). The model answers
  `{"type": "prd" | "issue", "reason": "..."}`. The run waits in `ingesting`
  meanwhile, without fetching the item again. The decision and its reason
  are stored on the run (`workflow_runs.source_classification`) and shown
  under the PRD or Issue on the run page; later cycles keep it, so an item
  never moves between PRD and Issue. When no computer can be asked, the
  command fails, the computer does not answer within 15 minutes (5 minutes of
  work plus queueing) or the answer is not a decision, the item is an Issue
  and the run page says why. The editor writes `prd:` only when there is an
  instruction.
- **Ids of triggers and actions.** The YAML has none. On save each item takes
  the id of the first saved item of the same type and connection (and stage,
  for actions; an action without `connection` matches one without), so
  editing a config, reordering or adding items keeps the run history linked;
  a removed item is deleted.
- **Shared YAML editor.** `packages/app/shared/components/yaml-code-editor.tsx`
  (CodeMirror setup) and `packages/app/shared/lib/yaml-cursor.ts` (where the
  cursor is, line based so it works on text that does not parse yet),
  `yaml-problems.ts` and `yaml-completion.ts` serve this editor, the project
  process editor and the connection editor (below).

### Connection configuration (YAML)

Connections (Settings → Compute & Integrations → Connections) are written as
YAML too, in the same editor
(`packages/app/integrations/components/integration-connection-dialog.tsx`,
`integrations/lib/connection-yaml.ts`, `connection-yaml-completions.ts`):

```yaml
name: Acme Jira
enabled: true                    # existing connections only
config:                          # the provider's settings (its non-secret fields)
  deployment: cloud
  siteUrl: https://acme.atlassian.net
  email: agentflow-bot@acme.com
inbound:                         # only for providers with inbound events
  mode: webhook                  # webhook | poll | none
  pollIntervalSeconds: 120
```

- A new connection starts from the provider's settings with their defaults,
  each with a comment naming it and its allowed values; required settings
  start empty and underlined.
- Suggestions: the keys, the provider's settings (label and description),
  their options, `true`/`false`, the inbound modes the provider supports.
- Problems: YAML syntax, the shape, every setting checked against its field
  descriptor (kind, options, required, URL, email), a mode the provider does
  not support, the poll interval range, and as warnings unknown keys and
  settings another setting turns off (e.g. `email` on Data Center).
- **Secrets never go in the YAML.** They are typed in password fields under
  the editor (stored secrets show their last four characters; an empty field
  keeps them). A secret written in the YAML is an error naming its field.
  Changing a credential origin setting (e.g. `siteUrl`) asks for the secrets
  again, as before.

## Code layout

```
apps/api/lib/integrations/
  types.ts                 provider contract (IntegrationProviderDefinition, InboundEvent, SourceItem, ActionResult, ...)
  registry.ts              the ONLY list of providers + lookups + toProviderSummary
  http.ts                  ProviderHttp (timeouts, never throws, retryable classification)
  inbound-auth.ts          verifyHubSignature / verifyStaticToken / verifyStandardWebhook / generateInboundSecret
  inbound-url.ts           why an inbound URL cannot be reached from the internet (localhost, private, http)
  server-connections.ts    connections the server provides to every organization (Local Git, from LOCAL_GIT_*)
  trigger-conditions.ts    all/any combination of the "conditions" triggers (Jira, Azure DevOps)
  markdown.ts              htmlToMarkdown, truncateText
  connection-service.ts    CRUD, sealing secrets, runtime loading, validation, inbound key/secret
  repositories.ts          repository listing/reading through a connection (repositories capability)
  pull-request-action.ts   "Create pull request" action shared by every provider with repositories
  connection-grants.ts     project connection keys as YAML names them; checks of a `connections:` grant
  project-connections.ts   project connections at run time (effective runtime, settings, source routing)
  agent-tools/
    catalog.ts             the integration tools of one agent session, from its `connections:` grants
    session-input.ts       what a session's tools are computed from (source connection, grant, project connections)
    field-schema.ts        JSON Schema of a tool's arguments from the operation's field descriptors
    item-read-tool.ts      connection_get_item
    operation-read-tools.ts  <provider>_<read> tools (confluence_get_page, ...)
    pull-request-tools.ts  pull_request_* tools
  connection/
    credential-origin.ts   re-enter secrets when a credential origin field changes
    secrets.ts             sealing a connection's secret fields
    project-accounts.ts    project connection accounts invalidated when the site changes
    provider-checks.ts     config/secret parsing with provider schemas, guarded provider hook calls
    server-connection-state.ts  state of the server-provided connection (Local Git)
    stored-json.ts         validated readers for connection/delivery JSON columns
    update-schedule.ts     status and poll schedule after an update (pure)
    dto-fields.ts          write-only secret state and delivery page size of the DTOs
    url-redaction.ts       url-kind config values as origin only for non-admin readers
  providers/
    jira/                  Jira Cloud + Data Center
    azure-devops/          Azure DevOps Services (work items, Azure Repos, Pipelines)
    github/                GitHub / GitHub Enterprise Server (fine-grained PAT; repositories)
    bitbucket/             Bitbucket Cloud (API token or access token; repositories)
    local-git/             Local Git = the docker-compose Gitea (token; repositories, creating them)
    microsoft-teams/       Teams Workflows (Power Automate) webhook
    confluence/            Confluence Cloud (pages and comments; reads and writes, no triggers)
    atlassian/             what Jira and Confluence share (API token auth, gateway, Markdown -> ADF)
    webhook/               generic HTTPS (Standard Webhooks)
apps/api/lib/workflows/
  workflow-service.ts      workflow CRUD, enable/disable, read redaction
  workflow-validation.ts   save validation (registry, scope, compute target rule)
  run-service.ts           run queries, DTO mapping, cancel, retry action run
  run-sessions.ts          agent sessions of the run's loops
  run-step-input-service.ts  answers to an agent step, decisions of an approval step
  workflow-http-endpoint.ts  the workflow's built-in HTTP trigger and HTTPS call (managed webhook connection)
  template.ts              {{variable}} renderer
  engine/
    ingest.ts              deliveries -> trigger matching -> runs (dedupe, resume)
    advance.ts             run state machine (lease-guarded, idempotent)
    phases.ts              one step per run status
    pre-actions.ts         the pre_actions step (inline, in order)
    run-loops.ts           run <-> loop mapping, revivable TIMED_OUT check
    process.ts             the run's process snapshot and current step
    launch-step.ts         launches the STEP loop of an agent step
    agent-step.ts          agent steps (running, outcome when the loop ends)
    agent-step-resume.ts   answers resume the asking loop's agent session
    approval-step.ts       approval steps (needs_approval until decided)
    review-step.ts         review loops on agent steps
    review-round.ts        what a decided review leads to (next step, feedback round, failure)
    review-signals.ts      labels and bot mentions on the source item that decide a review
    step-outcome.ts        what one step returns; the transition advance.ts applies
    step-documents.ts      files agent steps publish as documents
    release-notes.ts       release notes of the implement step
    retry-step.ts          retry of the step a run failed in
    cancel.ts              cancels a run's active loops
    run-process-view.ts    the run's process as its detail page shows it
    run-data.ts            zod readers/writers for workflow_runs JSON columns
    step-retry.ts          step retry backoff (stepAttempts / nextStepAt)
    launch.ts              programmatic PLAN/EXECUTE launcher (no HTTP)
    documents.ts           PRD or Issue + plan document creation / refresh
    source-classification.ts  PRD or Issue: the run's computer decides from agent.prd.instruction
    source-document.ts     which items are PRDs; their statuses
    source-classification-record.ts  WorkflowRun.sourceClassification (pending command, then decision)
    issue-document.ts      Markdown body and title of the imported Issue document
    source-connection.ts   the run's source connection with its effective runtime
    snapshot.ts            WorkflowRunSnapshot + summary markdown for actions
    run-repository.ts      run.repository at EXECUTE launch; action outputs (pull request) -> run
    run-session-pull-requests.ts  pull requests an action opened, shown on the run's sessions
    actions.ts             outbox enqueue + drain
    action-connection.ts   the connections an action works through (key, source, repositories, single offering)
    action-results.ts      one result for an action that ran on several connections
    action-run-order.ts    order of a run's action runs
    instruction-action.ts  instruction actions (read-only agent on the run's computer)
    email-action.ts        agentflow.email over SMTP_URL
    links.ts               absolute app links in post-action messages
    errors.ts              stored error message bound
    poll.ts                due-connection polling
    tick.ts                one scheduler tick (poll, sweep runs, drain outbox)
apps/api/lib/self-hosted-cron.ts   in-process cron runner started by server.ts
apps/api/app/integrations/**       connection + provider catalog routes
apps/api/app/projects/project-repository-service.ts   project repositories (add/list/primary/remove)
apps/api/app/projects/[id]/repositories/**             project repository routes
apps/api/app/projects/project-connection-service.ts   project connections (add/list/update/remove, scopes)
apps/api/app/projects/[id]/connections/**              project connection routes
apps/api/app/projects/project-process-service.ts      project process versions
apps/api/app/projects/project-runners-service.ts      project runners (GET/PUT /projects/{id}/runners)
apps/api/app/integration-tools/**  agent tool session + call routes and services
apps/api/app/desktop/integration-sessions/**  desktop integration session grant
apps/api/app/workflows/**          workflow routes
apps/api/app/workflow-runs/**      run routes
apps/api/app/webhooks/integrations/[inboundKey]/route.ts   public ingress
apps/api/app/cron/workflows/route.ts                       scheduler tick
packages/app/integrations/**       connection UI (hooks + components; the connection YAML editor)
packages/app/projects/components/project-repositories-panel.tsx   Project -> Integrations: repositories
packages/app/projects/components/project-connections-panel.tsx    Project -> Integrations: project connections
packages/app/projects/components/project-process-panel.tsx        Project -> Process (YAML editor)
packages/app/projects/components/project-runners-panel.tsx        Project -> Integrations -> Runners
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

The inbound URL is `${PUBLIC_WEBHOOK_BASE_URL ?? NEXT_PUBLIC_API_URL ?? http://localhost:3002}/webhooks/integrations/{inboundKey}`.
Jira Cloud and Azure DevOps must reach it over public HTTPS (Jira Cloud
allows port 443 among a few others; ADO refuses localhost/private IPs). For a
machine behind NAT use a tunnel/reverse proxy, or switch the connection to
**poll** mode. `GET …/inbound` returns `inboundUrlWarning`
(`apps/api/lib/integrations/inbound-url.ts`) when the URL is plain HTTP,
localhost or a private address, and the Inbound setup dialog shows it: with
neither variable set, the URL is `http://localhost:3002/…`, which no cloud
service can call.

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
entered `pre_actions` (an instruction's agent then holds the run there until
it answered; the tick checks every `WORKFLOW_TICK_SECONDS`).

| Status | Step |
|---|---|
| `received` | → `ingesting`: the item is imported first, so the pre actions (an instruction's agent in particular) have the run's documents and workspace. |
| `pre_actions` | Execute the cycle's pre action runs **one at a time in action order**, inline, with the same executor and retry/backoff as post actions. The first non-final row decides: due → execute now and continue with the next; waiting for its backoff or its agent (`waiting`) → stop (the tick advances the run later). A row that ends `failed` stops the run with `pre_action_failed` ("Pre action <display name> failed: <error>") unless the action has `continueOnError`; `skipped` rows count as done. All rows final → back to `ingesting` in the same call, which starts the agent team. Pre actions see a snapshot with event `workflow.triggered` and status `pre_actions`, with the run's documents (the PRD or Issue and the plan, imported before them: `{{feature.url}}`, `{{plan.url}}`) and no process step. The run page's stepper shows these actions as **Triggered actions**, between Importing and Planning, and the Actions card labels them **Before agents**. |
| `ingesting` | Validate the workflow (enabled, project, run-as user is an active org member, compute target configured). Load the connection runtime. Get the item: `inlineItem` or `provider.source.fetchItem(ctx, item)`. A temporary source failure (`RetryableSourceError`: rate limited, 5xx, timeout, network) keeps the run in `ingesting` and retries the step after 30 s, 2 min, 10 min, 30 min (`stepAttempts += 1`, `nextStepAt = now + backoff`); the fifth failed attempt fails the run with `source_fetch_failed`. Any other fetch error fails the run at once. With `agent.prd.instruction` and no decision yet, ask the run's computer to classify the item and wait here for its answer (see "PRD or Issue"); a tick while it decides does not fetch the item. Create (or, on resume, refresh) the **source** document in the workflow project with the title from `agent.titleTemplate`: a **PRD** (`DocumentType.Prd`, status `APPROVED`, the item's description as its body) when the computer decided the item is one, else an **Issue** (`DocumentType.Feature`, status `IN_PROGRESS`, the markdown body below); then the **plan** document (`DocumentType.ImplementationPlan`, `sourceId` = the PRD or Issue, status `DRAFT`): the plan is generated from the PRD like the "Generate plan" flow of a PRD written in AgentFlow, mirroring `resolveOrCreatePlanDocument` in `app/documents/execution-service.ts`. Record activity with `captureArtifactCreation` (`authMethod: "api_key"`, shown as an agent). Then the cycle's pre actions: none enqueued yet and the workflow has enabled pre actions → enqueue `workflow.triggered` → `pre_actions`; enqueued and not all final → `pre_actions`. Once they are done (`pre_actions` comes back here, which fetches the item again) launch PLAN. On success → `planning` and enqueue `workflow.started` (cycle 1 only) and `plan.started`. |
| `planning` | Read the latest run loop with command PLAN. Not terminal → wait. A revivable `TIMED_OUT` loop (below) → wait. `COMPLETED` → enqueue `plan.completed`; open questions come from the plan's uploaded artifacts (`lib/loops/uploaded-plan-artifacts.ts`). Mode `plan` → `succeeded`. Mode `plan_and_execute`: open questions and `stopOnOpenQuestions` → `needs_input` (+ `input.needed`); otherwise set the plan document status `APPROVED` and launch EXECUTE → `executing` (+ `execute.started`). Any other terminal status (`FAILED`, `CANCELLED`, a `TIMED_OUT` that can no longer be revived) → `failed` with the loop error. |
| `executing` | Latest EXECUTE run loop. Not terminal, or a revivable `TIMED_OUT` → wait. `COMPLETED` → store `prUrl`/`branchName` (loop fields or `primaryPullRequest`), set the Issue status to in-review (a PRD: executed), enqueue `execute.completed` → `succeeded` (or the process's next step). Other terminal statuses → `failed`. |
| `needs_input` | Adoption: a loop created on the plan document after `phaseStartedAt` and not yet mapped is attached to the run (`adopted = true`): PLAN → `cycle += 1` (so `plan.started` / `plan.completed` / `input.needed` post actions fire again; pre actions do not run) and `planning` (+ `plan.started`); EXECUTE → `executing` (+ `execute.started`). A re-assignment of the source item resumes the run through ingest (pre actions run again for the new cycle). |
| `running` | An agent step of the project's process (below): wait for its STEP loop, then the next step. |
| `needs_approval` | An approval step of the project's process (below): wait for an admin's decision. |
| `succeeded`, `failed`, `cancelled` | Final. Later loop changes (a FAILED loop later reported COMPLETED) are ignored. A `failed` or `cancelled` run of a project process can be retried (below). |

**Retrying a step** (`engine/retry-step.ts`, `retryRun` in `advance.ts`). A
run that is `failed` or `cancelled` while its current process step is a plan,
implement or agent step (`stepId`) can run that step again: the run detail
carries it as `retryStep`, and an admin presses **Retry <step>** on the run
page (`POST /workflow-runs/{id}/retry`). The run keeps its documents, its
approved plan and the answers given; the step gets a new loop in a new cycle
(`cycle += 1`, so the step's post actions such as `execute.started` fire
again), `error` and `completedAt` are cleared and the run takes the step's
status. Steps before it and pre actions do not run again. Not retryable: the
built-in flow (no process snapshot), a failure before planning (re-trigger the
source item instead), a rejected approval, a disabled workflow. If the step
cannot start (its computer is offline), the run stays as it was and the
request answers 409 with the reason.

Entering `succeeded` enqueues `workflow.completed`, entering `failed` enqueues
`workflow.failed`. A process step that pushes (`finish: push`) enqueues
`execute.started` when it starts and `execute.completed` when it ends, like
EXECUTE; a process's own PLAN step enqueues `plan.started`. Each event fires
once per cycle (`workflow.started` once per run). Runs in `planning`/`executing` longer than
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
repositories), and written in the workflow YAML as `agent.process` (the same
keys as Project → Process, with that editor's suggestions and problems; left
out, the run uses the project's process). Runs show "The workflow's own
process" instead of a version.

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

- `releaseNotes` (implement step, default true): a workflow EXECUTE writes
  release notes when it is done (`AGENTFLOW_RELEASE_NOTES=1`; "Step roles"
  below). Unlike the two settings above it is sent by default, and
  `releaseNotes: false` sends nothing.

These settings belong to workflow runs. The plan and Execute actions on a
document keep the defaults (no release notes).

**Approval steps** (`approval`, `engine/approval-step.ts`) move the run to
`needs_approval` and enqueue `input.needed`, so the post actions that
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
adopted plan), so each later wait enqueues `input.needed` again; answers
on the source item already start one through ingest. Pre actions do not run
for these cycles.

**Agent steps** (`agent`, `engine/agent-step.ts`) run in `running`, one
`STEP` loop each (`engine/launch-step.ts`):

- The loop works in the project repositories (integration connections), all
  of them in one workspace, from the workspace root. The run's plan document
  is the loop's document when the process has a plan step (`agentflow.plan`,
  or an agent step with `role: plan`; the steps then share PLAN / EXECUTE's
  workspace and branch), else its Issue; a process without a plan step gets
  no plan document. A loop on the plan also gets the run's PRD or Issue
  (a context ref), and `.agentflow-ai/work/issue.md` is that item, not the
  plan.
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
- A step's `connections:` grant (same form as an instruction's) gives its
  agent the integration tools (see "Integration tools"): `source: [comment]`
  lets it comment on the run's source item, `<key>: read` read items of that
  project connection. Without it the agent only has the Issue in the
  workspace. The grant is checked when the process is saved, against the
  connections of every project that uses it.
- A step with `questions: ask` that wrote questions moves the run to
  `needs_input` (`input.needed`) and records them in
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
  Issue) instead of starting the process over. The comments the run posted
  itself (comment tool calls and Jira comment actions, by their external
  ref) are never answers; when people replied in the thread of one of them
  (Jira comment `parentId`), only those replies are taken, otherwise the
  top-level comments, so two runs waiting on the same item each read the
  answers to their own questions. A reply in the thread of one of those
  comments also resumes the run by itself, whatever the workflow's triggers
  are (`engine/answer-replies.ts`, the provider's `answerReply` hook; Jira:
  a new comment with a `parentId`, the `jira.comment_reply` event): the
  delivery resumes exactly the `needs_input` run of the item that posted the
  replied comment, and starts no run.
- A STEP loop that does not complete fails the run with `step_failed`; a step
  that asks but wrote questions that do not parse fails it too. The phase
  timeout applies to each step.

**Step roles.** An agent step may say what it is to AgentFlow with `role`, so
a toolkit command (Spec Kit, a team's own skills) only has to do the work and
AgentFlow keeps its features working (`ProcessStepRole`,
`packages/api/src/types/project-process.ts`). The computer adds the role's
contract to the step's section of the workspace `CLAUDE.md`
(`loop-step.ts` `buildStepWorkspaceInstructions`), so the instruction does not
have to repeat it.

```yaml
steps:
  - type: agent
    id: plan
    name: Plan
    role: plan
    instruction: Use the plan-ticket skill for {{issue.key}} ({{issue.file}}).
    questions: ask
  - type: approval
    id: approve-plan
    name: Approve the plan
  - type: agent
    id: implement
    name: Implement
    role: implement          # always pushes
    instruction: Use the implement-ticket skill to implement the approved plan.
    # releaseNotes: false    # on by default
```

- `role: plan` writes the run's implementation plan. The agent is told to
  write the final plan to `.agentflow-ai/work/plan.md` (copied there when its
  tools wrote it elsewhere). The engine collects that file first and keeps it
  as a new version of the run's plan document (the one `agentflow.plan` uses,
  created at ingest for such a process), then reports `plan.completed`;
  entering the step reports `plan.started` (also when answers resume it). A
  step that asks keeps a draft plan it wrote and stops for its questions. A
  step that ended without the plan and without questions is resumed once to
  write it (`step_state.outputRepair`, `planRepairPrompt`); still none fails
  it (`step_failed`).
- `role: implement` works from the approved plan: entering the step approves
  the plan document (as EXECUTE does), and the computer writes the plan's
  latest version to `.agentflow-ai/work/plan.md` before the agent starts, so
  a plan edited in AgentFlow wins over the file on disk. It always pushes
  (`finish` is ignored) and reports `execute.started` / `execute.completed`.
  Unless `releaseNotes: false`, the agent writes release notes to
  `.agentflow-ai/work/release-notes.md`; the engine publishes them as a DOC
  of the project ("Release notes: {{issue.key}} {{issue.title}}", a new
  version per round; linked from the Issue under `<step id>.release-notes`),
  and post actions get them as `{{releaseNotes}}` and `{{releaseNotes.url}}`.
- AgentFlow's own implement step (`agentflow.execute`, also on the built-in
  flow) writes release notes the same way unless `releaseNotes: false`: its
  loop gets `releaseNotes` in its agent policy (`AGENTFLOW_RELEASE_NOTES=1`),
  the code plugin's orchestrator writes `release-notes.md` in its work
  directory at the end (`agent-plugins/code/prompts/execute-prompt.md`
  Phase 7), the computer uploads it as `releaseNotes`
  (`execute-release-notes.ts`), and the engine publishes it when EXECUTE
  completes (`engine/release-notes.ts`; best effort: a failure is logged and
  the run goes on).
- Rules: at most one plan step (`agentflow.plan` or `role: plan`); an
  implement step needs a plan step before it; a plan step cannot also publish
  an `IMPLEMENTATION_PLAN` document; `releaseNotes` only on an implement step
  (`role: implement` or `agentflow.execute`).

**Review loops.** An agent step with `review` stops the run after its work
until people decide, in AgentFlow or on the source item
(`engine/review-step.ts`, `review-round.ts`, `review-signals.ts`):

```yaml
steps:
  - type: agent
    id: plan
    role: plan
    instruction: Use the plan-ticket skill for {{issue.key}}.
    review:
      approve:  { labels: [plan-approved] }         # a plan step: approve
      feedback: { labels: [replan], mention: true }  # run the step again
      instruction: |                                 # added to a feedback round's prompt
        Replan with: {{feedback.text}}. Read the open comments of the plan page.
      # session: resume (default) | fresh
      # consumeLabels: true (default): remove a feedback label once acted on
  - type: agent
    id: implement
    role: implement
    instruction: Use the implement-ticket skill.
    review:
      complete: { labels: [done] }                   # any other step: end the review
      feedback: { labels: [fix-review], mention: true }
  - type: approval
    id: release
    name: Approve the release
    approve: { labels: [ship-it] }                   # an approval step by label too
```

- When the step's loop ends without questions, the run goes to
  `needs_approval` (`input.needed`) with `step_state.review` (step, latest
  loop, round, requested at, decision, history of earlier rounds).
- **Approve** (a plan step: `approve`; any other step: `complete`): a plan
  step's plan document is approved, then the next step starts in a new cycle,
  or the run succeeds after the last step. **Feedback**: a feedback round runs
  the same step again (`plan.started` / `execute.started` in a new cycle): it
  resumes the step's session on its computer (`resumeLoopId`, `--resume`) with
  a prompt that says who asked what and how, then the rendered
  `review.instruction` (`{{feedback.text}}`, `{{feedback.author}}`,
  `{{feedback.via}}`, `{{review.round}}`); `session: fresh` starts a new
  session with the step's instruction and the feedback. A pushing step pushes
  to the same branches, so its pull requests update. The step then waits
  again, one round later. **Reject** (AgentFlow only): `failed` with
  `review_rejected` (not retryable).
- **In AgentFlow**: `POST /workflow-runs/{id}/review` (`{ decision: approve |
  feedback | reject, comment }`; feedback for any member, approve and reject
  for org admins). The run page's Process card shows the review panel
  (Approve / Replan on a plan step, Done / Request changes on any other,
  Reject, and the earlier rounds).
- **On the source item**: providers report what an occurrence signals
  (`reviewSignal` on the provider definition: Jira's and Azure DevOps's
  conditions events, with the labels or tags they added and whether they
  mention the bot). Before triggers are matched, ingest hands each event to
  the active runs of its project connection and item: a matching label or
  mention decides the waiting review (or approval step), and a run still
  working (`running`, `planning`, `executing`) on that step or the step
  before it queues the signal (`step_state.pendingSignals`, at most 10),
  applied as soon as the step waits (then nobody is notified of a wait). A
  run waiting for answers (`needs_input`) is left to the triggers. The
  workflow whose run took the signal does not match it as a trigger, so a
  signal never starts a run; the delivery reports "N runs resumed". An
  occurrence decides once (`occurrenceKeys`); an approve and a feedback label
  at once are ignored; the write only applies while the run is as read.
- A feedback's text is read when its round starts: the item's comments since
  the previous decision up to this one, without the bot's
  (`readFeedbackComments`). A feedback label is then removed from the item
  with the provider's label operation (`removeSourceLabel`; the one write on
  a source system the engine does on its own; best effort), so it can be
  added again. Approve labels stay.
- `input.needed` of a review says how to decide: the plan link (plan step),
  the labels, the mention, and the run link.

**In the app.** Project → **Process** shows the project's process (or "AgentFlow
(default)"), edits it from the AgentFlow or Spec Kit preset (toolkit, steps,
per-step settings), saves versions, lists the history and restores one; only
org admins save, and members see the process and its history without the
editing controls (the project's repositories, runners and agent instructions
are read-only to them the same way). A workflow's `agent.mode` and
`agent.stopOnOpenQuestions` only apply when neither the workflow
(`agent.process`) nor its project has a process; the configuration guide says
so next to those keys. A run's page shows a
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

### Runner rules

`agent.runners` (`packages/api/src/types/workflow-runner-rules.ts`) chooses a
run's runner from its source item, e.g. sending every ticket to the personal
runner of its assignee (docs/runner.md "Personal runner"):

```yaml
agent:
  runner: runner-1                       # when no rule matches
  runners:
    - runner: an-PRO-1
      condition: source.assignee_email == "an@acme.dev"
    - runner: binh-PRO-1
      condition: source.assignee == "Trần Bình" && source.status == "Ready for Testing"
```

- **When.** Once per run, in `ingesting`, right after the item is fetched
  (`engine/runner-rules.ts`): the first rule whose condition holds names the
  runner, else `runner`. The decision is written into the run's
  `agent_config` (that runner, no rules), so the PRD decision, PLAN, every
  step and a later cycle of the run keep it.
- **Conditions.** A field compared with a quoted value: `==`, `!=`,
  `contains` (a list field has the value; a text field contains it) and
  `in ["a", "b"]`, combined with `&&` / `and`, `||` / `or`, `!` / `not` and
  parentheses. Comparisons ignore case and surrounding spaces; a field the
  item lacks is empty. Fields: `source.key`, `source.title`, `source.type`,
  `source.status`, `source.priority`, `source.labels`, `source.assignee`,
  `source.assignee_email`, `source.reporter`, `source.reporter_email`,
  `source.provider`. The emails are the provider's: Jira shares them only
  per the user's profile visibility (match `source.assignee` by name when it
  hides them); Azure DevOps gives an Entra ID account's unique name.
- **Saving.** Each rule's runner follows the access rule of `runner` (owned
  by the run-as user or shared with the organization), and a condition must
  parse; the editor reports both on the rule's line, and an offline runner
  as a warning.
- **Project runners.** A project that lists runners runs on them, but a
  personal runner a rule (or `runner`) names is kept: it refuses another
  project's loops itself.
- **A busy personal runner.** A step whose runner is a personal runner that
  runs one task at a time, while another loop holds it, waits
  (`runner_busy`, retried every minute, `engine/personal-runner-queue.ts`)
  instead of failing the run.

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

## Links                      (web links: Jira remote links, Azure DevOps Hyperlinks)
- [{title}]({url})

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

A workflow's actions are one ordered list (`position`); each runs `on` run
events. Pre actions (`workflow.triggered`): see the `pre_actions` step above.
They block the agent team, run in order, and their failure fails the run
unless `continueOnError`.

Post actions: `enqueueRunEvents(run, events)` inserts one
`workflow_action_runs` row per enabled **post** action subscribed to each
event (`createMany` + `skipDuplicates` on `(runId, actionId, event, cycle)`),
in the workflow's action order (then event order for an action on several of
the transition's events), then `waitUntil(drainActionRuns({runId}))`.

**Order** (`engine/action-run-order.ts`): a run's rows go transition by
transition (the rows one transition enqueues share their creation time),
then by action position, then by event. One transition may emit several
events (`execute.completed` and `workflow.completed` when EXECUTE finishes),
and its actions run in list order whatever their event: a pull request
action listed before a summary instruction runs first, so the summary sees
`{{pr.url}}`. A row that cannot finish yet (waiting for its backoff or its
agent, or held by another worker) holds every later row of its run.

The drain only handles `stage = post` rows: for each run with a due or
waiting row (oldest first, max 50 runs), it walks the run's open rows in
order. A due pending row is claimed with an `updateManyAndReturn` from
`pending` to `running` that re-checks `nextAttemptAt <= now` and increments
`attempts`; the attempt number (`ctx.attempt`, the backoff and the attempt
limit) is the value the claim returned, never the earlier read. A waiting row
is checked (instructions, below). The first row that does not end final stops
the run's walk, so overlapping drains (the background drain after a
transition and the tick) never run one run's rows side by side or skip a
backoff. The claimed row's action and connection (below) are loaded, the
config is parsed with the action's `configSchema`, the `WorkflowRunSnapshot`
is built, and `action.execute(ctx)` is called:

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

**Connection chosen by the run** (`engine/action-connection.ts`). An action
naming a key (`workflow_actions.connection_key`) works on that project
connection of the run's project; on the source item it only runs for runs
from that connection and is skipped for others. Only the workflow's built-in
HTTPS call stores a `connection_id` (its managed connection). An action
saved without either (`automaticConnection` in the API) works on:

- an instruction, or an action on the source item (a comment, a
  transition): the run's source project connection
  (`workflow_runs.project_connection_id`, whose item started the run);
- a repository action (`repositoryScoped` in the registry and the provider
  catalog: every `*.create_pull_request`): every connection offering the type
  that holds one of the run's repositories (`workflow_runs.repository`, which
  EXECUTE fills with each project repository and the branch it pushed). The
  action runs once per connection and their results merge into the row
  (`engine/action-results.ts`): every pull request is recorded, the row fails
  when one connection failed (retried when that failure is retryable) and is
  skipped only when all skipped. On each connection the action opens one pull
  request per repository it holds that has a pushed branch and no pull
  request yet; a repository EXECUTE did not change gets none. A run without
  recorded repositories uses the first connection that offers the type,
  like any other typed action;
- any other typed action: the project's only connection that offers the
  type; with none or several the action is skipped with the reason ("Name
  one for the action").

Saving checks the same (`workflow-validation.ts` `validateAutomaticAction`):
a source item action needs a trigger whose provider offers it, a pull request
a repository connection that offers it, and any other type exactly one
offering connection in every trigger project (none: "Add one on the project's
Integrations tab"; several: "Name one with connection:"). A run whose
connection does not fit (a workflow with triggers on several providers, a run
started by hand) skips the action with the reason.

A project whose repositories are on several providers (Local Git and GitHub,
say) needs one pull request action per provider type
(`local_git.create_pull_request`, `github.create_pull_request`); each may
leave the connection out.

### Instructions

An action of type `agentflow.instruction` (`config.instruction`, a template:
`{{source.key}}`, `{{pr.url}}`, ... work) is carried out by an agent on the
run's computer (`engine/instruction-action.ts`):

1. **Start** (the row's attempt): the API renders the instruction and builds
   a prompt: the instruction, the event, the run (source, links, pull
   requests, repositories, error, step replies, the event summary; marked as
   untrusted data), where the run's context lives, the session's integration
   tools (below; none granted: the prompt says the agent only reads) and the
   answer contract. It opens the attempt's tool session
   (`integration_tool_sessions`, bound to the chosen computer) and sends the
   prompt as a desktop command (`workflow_instruction`,
   `POST /api/gateway/workflow-actions/instruction`, unsigned like the
   workflow's loops, with the computer's model provider and Claude Code
   version) to the computer of the run's latest loop (else the one its first
   loop gets); the row goes `waiting` with the command id.
2. **The agent** (`apps/desktop/src/server/operations/workflow-instruction.ts`)
   runs in the run's workspace, `<worktree parent>/loops/<plan slug>` (the
   Issue's slug without a plan), the folder PLAN, EXECUTE and the steps share:
   `.agentflow-ai/work/prd.md`, `plan.md`, `plan.json`,
   `execution-result.json`, one folder per repository on the run's branch.
   The runner first exchanges the action run for the session's token
   (`POST /desktop/integration-sessions`) and writes an MCP config naming only
   `agentflow_integrations` with `Authorization: Bearer
   ${AGENTFLOW_INTEGRATION_TOKEN}`; the token itself is only in the agent's
   environment. Claude Code runs read-only: `--permission-mode default` with
   only `mcp__agentflow_integrations`, `Read`, `Grep`, `Glob` and
   `git log/diff/show/status` allowed, `Write`, `Edit`, `NotebookEdit`,
   `WebFetch`, `WebSearch` denied, `--mcp-config <file> --strict-mcp-config`
   (no MCP server of the computer's own configuration) and the plugins a loop
   loads (secret guard). Prompt, MCP config, transcript and result go to
   `.agentflow-ai/actions/<actionRunId>/`. The answer streams back as ndjson
   (`status`, then the `result` line, then `done`), so the command executor's
   60 s response timeout does not apply; the agent has 15 minutes.
3. **Tools**: the agent reads and writes through the integration tools; the
   API checks and carries out every call while the agent works (see
   "Integration tools"). Its final answer is a short note, not carried out.
4. **Settle**: the tick (or the pre_actions step) checks the waiting row; once
   the command is `done` the row is claimed `waiting` → `running` and settled
   from the attempt's recorded calls: `succeeded` (`externalRef` of the first
   write that has one) unless a write failed or never finished, with
   `detail` = the note, each call (tool or operation type, connection key,
   arguments, status `succeeded` / `failed` / `skipped` for a refusal /
   `not_run`, external reference, error) and Claude Code's tokens and cost
   (null when unknown). An agent failure, a failed or expired command, no
   answer within 25 minutes (the command is expired so a reconnecting computer
   does not run it) or a failed write with none succeeded → retried like any
   action, with a new session (the old token stops working). Once a write
   succeeded, a later failure is final, so nothing is written twice.

A run that stopped before its documents existed has no workspace: its
instructions are `skipped`. The run page lists each instruction's note,
tool calls and usage under Actions; the agent's session is not a loop and
does not appear on the Sessions page.

### Email

An action of type `agentflow.email` emails the run event through the
server's own mail relay: `SMTP_URL`, from `EMAIL_FROM`, the relay that also
sends invitations and password resets (Mailpit in development). It needs no
connection, so it works for runs from any source; whether a run sends one,
on which events and to whom, is the workflow's choice:

```yaml
actions:
  - on: input.needed                   # a step's questions, an approval, a review
    type: agentflow.email
    config:
      to: [ada@acme.dev, ops@acme.dev] # required, at most 20
      cc: [lead@acme.dev]              # optional
      subject: "[AgentFlow] {{source.key}} needs you"   # optional template
      body: |                          # optional template, plain text
        {{summary}}

        Answer in AgentFlow: {{run.url}}
```

- `input.needed` fires when the run waits for people: a plan or step with
  open questions (`needs_input`), an approval step (`needs_approval`), a
  review round. Any other run event works too (`workflow.failed`, ...).
- Without `subject`, the subject says what the event asks for (`Your answer
  is needed`, `Approval needed`, `Review needed`, else the workflow and the
  event) and names the item (`[AgentFlow] Approval needed: CALC-1: Add
  history`). Without `body`, the body is `{{summary}}` (the questions or the
  approval asked for, with the run link) followed by the workflow, item and
  run links. Every `{{variable}}` of the other actions works in both.
- Without `SMTP_URL` the action is `skipped` with the reason. A relay that
  cannot be reached or answers 4xx is retried like any action; a 5xx refusal
  fails it. Retries keep the same `Message-ID`
  (`<workflow-action-{actionRunId}@agentflow>`).
- Code: `lib/workflows/engine/email-action.ts` (sending), `lib/mail-transport.ts`
  (the relay, shared with `lib/auth/auth-email.ts`), the contract in
  `packages/api/src/types/workflow-email.ts`.

### Integration tools

Agents never hold integration credentials. An instruction's agent, and the
agent of a process agent step whose `connections:` grants anything, gets an
MCP server, `agentflow_integrations` (`apps/mcp`, authenticated by an
`ist_…` session token), whose tools are computed from that grant on every
request (`apps/api/lib/integrations/agent-tools/catalog.ts`):

| Tool | When | What it does |
|---|---|---|
| `integrations_overview` | always | What this session may do (also the MCP server instructions and the prompt's tools block). |
| `source_item_get` | the run has a source connection | Reads the run's source item: title, status, description, labels, assignee, latest comments, web links, attachment names, URL. |
| `source_item_attachment_read` | the source provider reads attachments (`IntegrationSourceDefinition.readAttachment`: Jira) | Reads the text of one file attached to the run's source item, by its name (`{ name }`, case-insensitive, as `source_item_get` lists it). A read: no grant. The API downloads it with the connection's credentials (Jira Cloud `GET attachment/content/{id}`, Data Center the attachment's link on the site; `providers/jira/attachment-read.ts`), so the instruction decides which file to read and what it is (e.g. "the PRD is the attachment PRD-<KEY>.md") while the computer holds no credentials. Only text up to 1 MB; an image or other binary file, or a name the item does not have (the error lists its attachments), is refused. |
| `source_item_comment` | `source: [comment]` | Comments on the run's source item; with `attachments`, shows files the agent uploaded to it first (Jira; see "Comment attachments"). |
| `source_item_transition` | `source: [transition]` | Moves the run's source item (Jira transition, Azure DevOps state). |
| `source_item_label` | `source: [label]` | Adds labels to, or removes them from, the run's source item (Jira labels, Azure DevOps tags). |
| `source_item_link` | `source: [link]` | Adds a web link to the run's source item, e.g. the page its plan is reviewed on, so a later run finds it in the item's links. |
| `connection_get_item` | any grant on a key whose provider has items (Jira, Azure DevOps) | Reads one item by key, id or link, refused unless it is in that project connection's projects. |
| `<provider>_<read>` (`confluence_get_page`, `confluence_find_pages`, `confluence_list_comments`) | any grant on a key whose provider offers reads (`IntegrationProviderDefinition.reads`) | Reads through one of those keys (`connection` enum); the provider keeps to the project connection's settings (Confluence spaces). |
| `<provider>_<operation>` (`microsoft_teams_post_message`, `webhook_post`, `azure_devops_run_pipeline`) | the operation is granted on a key | Carries it out on one of the keys granting it: `connection` is an enum of exactly those keys. |
| `pull_requests_list` | a `pull_requests` grant | The pull requests this run opened, with repository, number, state (open, merged, declined) and title. |
| `pull_request_threads` | a `pull_requests` grant and the run has a pull request | A pull request's review threads (`status: open` by default, or `all`): general and line comments with their replies, each comment marked `mine` when the agent wrote it. |
| `pull_request_reply` | `pull_requests: [reply]` | Replies in a review thread. |
| `pull_request_resolve` | `pull_requests: [resolve]` | Marks a review thread resolved (a resolved one is not an error). |

- The source tools take neither an item nor a connection: the item is the
  run's, pinned by AgentFlow, so a key written in the ticket cannot redirect
  them (two Jiras in one project: the run from `jira-customer` only ever moves
  its own issue).
- Fields fixed by the grant (`with`) are not arguments and win over anything
  sent. Template fields the workflow wrote (fixed, or left to their default
  such as `{{summary}}`) are rendered against the run; the agent's own text is
  used as written.
- `approval: required`: the tools stay, but each write is recorded
  `pending_approval` with its arguments and the agent is told so. The run
  page lists every call under "Integration tool calls"; an org admin approves
  (`POST /workflow-runs/{runId}/tool-calls/{callId}/decision`, the call is
  carried out then, through the tools the session has now) or rejects it. A
  pending write does not fail its instruction.
- **Comment attachments** (test evidence, screenshots, logs). When the run's
  source provider attaches files (`IntegrationSourceDefinition.attachFile`:
  Jira; Azure DevOps has a placeholder in
  `providers/azure-devops/attachments.ts`, not wired yet) and the `source:
  [comment]` grant needs no approval, `source_item_comment` takes
  `attachments`: ids of files the agent uploaded first. The runner writes an
  upload helper next to the agent's MCP config and names it in
  `AGENTFLOW_ATTACH` (with `AGENTFLOW_INTEGRATION_FILES_URL`, the API it
  asked the session from); `"$AGENTFLOW_ATTACH" <file> [content-type]` posts
  the bytes to `POST /integration-tools/files` (Bearer session token, name in
  `X-File-Name`, at most 8 MB; the type falls back to the extension) and
  prints `data.output.id`. The upload attaches the file to the item at once
  (`app/integration-tools/service/attachments.ts`): it is a write of its own,
  counted in the budget, recorded as `source_item_attach` and idempotent on
  the file's name, type and content hash, and refused without such a comment
  grant. A comment may only name this session's uploads, at most 10. Jira
  Cloud shows images inline (ADF external media on the attachment's content
  URL, which the reader's own Jira session loads) and links every file; Data
  Center appends wiki markup (`!name|thumbnail!`, `[^name]`). Typed
  `jira.add_comment` actions take no files.
- `GET /integration-tools/session` lists the tools,
  `POST /integration-tools/call` carries one out
  (`apps/api/app/integration-tools/`). A token works only while its agent
  runs: the instruction's action run on that attempt and not settled, or the
  step's STEP loop. Every call is recorded in `integration_tool_calls`; a
  write is recorded before it runs and keyed by session + tool + arguments, so
  an identical repeat answers with the first result instead of writing twice.
  At most 5 writes per instruction attempt, 100 per step loop; an unknown tool,
  a key outside the grant or arguments the operation rejects are refused
  (recorded, nothing sent to the provider).
- Tokens: an instruction's runner asks with its own API key for its compute
  target (`POST /desktop/integration-sessions`), and only the computer the
  attempt was dispatched to gets one. A step's runner asks with the loop's own
  runner token (`POST /loops/{id}/integration-session`); the engine opens that
  session when it launches a STEP loop whose step has a grant
  (`step.integrationTools`). The API names the MCP endpoint
  (`AGENTFLOW_MCP_URL`, default `http://localhost:3010/mcp`); a runner that
  reaches it under another address sets its own `AGENTFLOW_MCP_URL`.
- A STEP loop's agent gets the MCP config next to its other MCP servers (no
  `--strict-mcp-config`), with `mcp__agentflow_integrations` added to its
  allowed tools; the token is only in its environment.
- Pull request review tools: the reserved grant key `pull_requests` (`read`,
  or `[reply, resolve]`, optionally `approval: required`; no `with`) gives an
  agent the review threads of the run's own pull requests, e.g. a step that
  addresses a code review on Bitbucket Cloud or Azure Repos. Like the source
  tools they take no connection: `pullRequest` is an enum of the run's pull
  request URLs, and each one is read and answered through its repository's
  connection (`apps/api/app/integration-tools/service/pull-requests.ts`,
  provider `repositories.pullRequests`; GitHub and local Git answer "not
  supported" for now). Bitbucket has no thread object: a thread is a root
  comment and every reply below it, its id the root's. Azure DevOps threads of
  the system (votes, pushes) are left out, and resolving sets a thread to
  `fixed`. A comment is `mine` when the connection's account wrote it or this
  run's `pull_request_reply` recorded it (a Bitbucket access token has no
  account), so a thread whose last comment is the agent's was answered
  already. The pull request state is information only, never a review
  signal: a step under review completes by its labels or the Done button
  ("Review loops").
- An agent whose runner never opened its tools (a runner from before
  integration tools) fails: the instruction finally, the step's run with
  `step_failed`, instead of passing as if it had acted.

`ctx.render(template)` renders `{{path}}` placeholders from
`WORKFLOW_TEMPLATE_VARIABLES` (`summary`, `run.url`, `source.key`,
`pr.url`, ...). Unknown names render empty; values are inserted verbatim (no
HTML escaping — providers escape for their own format). `summary` is a
ready-made markdown text per event, so the default template of every message
field is `{{summary}}`:

| Event | Summary |
|---|---|
| `workflow.triggered` | 🤖 AgentFlow received **{key}** ({title}) and is about to start working on it. Follow the run: {run.url} |
| `workflow.started` | 🤖 AgentFlow picked up **{key}** and started planning. Follow the run: {run.url} |
| `plan.started` | 🧭 AgentFlow is writing the implementation plan for **{key}**. Follow the run: {run.url} |
| `plan.completed` | 📝 The implementation plan for **{key}** is ready: {plan.url} + excerpt |
| `input.needed` | ❓ The plan for **{key}** has open questions that need an answer before implementation: list + {plan.url}. Answer them on the ticket and assign it to the bot again, or approve the plan in AgentFlow. A project process step instead: ❓ The "{step.name}" step for **{key}** has questions that need an answer: list + answer on the ticket or in AgentFlow ({run.url}); an approval step: 🛂 The "{step.name}" step for **{key}** waits for an approval in AgentFlow: {run.url} (with its approve labels: add the label "…" to the ticket, or approve it in AgentFlow); a step under review: 🔎 The plan for **{key}** (or the "{step.name}" step) is ready for review (round n): the plan link, how to approve with labels, how to ask for changes (mention, labels), and the run link. `{{step.name}}` and `{{step.questions}}` (one per line) are empty on the built-in flow. |
| `execute.started` | 🛠️ AgentFlow started implementing **{key}** from the plan {plan.url}. Follow the run: {run.url} |
| `execute.completed` | 🛠️ AgentFlow finished implementing **{key}** (and pushed branch {pr.branch} once a pull request exists). Follow the run: {run.url} |
| `workflow.completed` | ✅ **{key}** is done. Pull request: {pr.url} (branch {pr.branch}). Several pull requests: one line per repository. Plan mode: plan link instead. |
| `workflow.failed` | ⚠️ AgentFlow could not complete **{key}**: {error.message}. Details: {run.url} |

The event names were `run.triggered`, `run.started`, `run.plan_ready`,
`run.needs_input`, `run.succeeded` and `run.failed` before; the API and the
editor still accept them (`normalizeWorkflowRunEvent`), and migration
`20261013090000_workflow_instruction_actions` renamed the stored ones.

`{{releaseNotes}}` is the latest version of the release notes an implement step
wrote (at most 30,000 characters) and `{{releaseNotes.url}}` its document; both
are empty until such a step ended ("Step roles" above).

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
| `GET /cron/reconcile-stale-sessions` | 1 h (ends agent sessions a machine stopped reporting, see self-hosting.md) |

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
org admin/owner (`denyUnlessOrgAdmin`). Connections and project connections
are admin-only for reads too: every `/integrations/connections*` route and
`/projects/{id}/connections*` (they carry the organization's integration
settings). Other reads (`/integrations/providers`, workflows, runs, project
repositories, runners, process) are open to any member. Secrets are never
returned except the inbound secret on the admin-only inbound endpoint.

Workflow reads by members who are not org admins hide outbound URLs, which
often carry a token in the path or query: `GET /workflows[/{id}]` returns
every trigger and action config field of kind `url` (e.g. the `webhook.post`
target) as its origin only, e.g. `https://hooks.example.com/…`. A config whose
provider or type is no longer registered is returned empty to them. Admins
get the full values (the routes pass the viewer from `resolveConfigViewer`;
create/update responses are admin-only and always full).

| Method | Path | Body → Response |
|---|---|---|
| GET | `/integrations/providers` | → `IntegrationProvidersResponse` |
| GET | `/integrations/connections` | → `IntegrationConnectionsResponse` |
| POST | `/integrations/connections` | `CreateIntegrationConnectionInput` → `IntegrationConnection` (validated with the provider first; 400 with the provider message on failure) |
| GET | `/integrations/connections/{id}` | → `IntegrationConnection` |
| PATCH | `/integrations/connections/{id}` | `UpdateIntegrationConnectionInput` → `IntegrationConnection` (re-validates when config or secrets change; 400 "Re-enter … when changing …" when a credential origin field changes without the secrets, see below) |
| DELETE | `/integrations/connections/{id}` | → `{deleted: true}`; 409 while used by a workflow trigger, action, project repository or project connection |
| POST | `/integrations/connections/{id}/test` | → `IntegrationConnectionTestResult` |
| GET | `/integrations/connections/{id}/inbound` | → `IntegrationInboundDetails` |
| POST | `/integrations/connections/{id}/inbound/rotate` | → `IntegrationInboundDetails` (new key and secret) |
| GET | `/integrations/connections/{id}/deliveries` | → `IntegrationDeliveriesResponse` (latest 50) |
| GET | `/integrations/connections/{id}/projects` | → `IntegrationConnectionProjectsResponse` (admin; the projects that use the connection, with their keys) |
| POST | `/integrations/connections/{id}/repositories` | `CreateIntegrationRepositoryInput` → `IntegrationRepository` (admin; providers with `repository_creation`, i.e. Local Git) |
| GET | `/integrations/connections/{id}/repositories?query=&limit=` | → `IntegrationRepositoriesResponse` (admin; repositories the connection can access, ≤ 100; 400 when the provider has no repositories, 502 with the provider's message when it fails) |
| GET | `/projects/{id}/connections` | → `ProjectConnectionsResponse` (admin; key, connection, settings) |
| POST | `/projects/{id}/connections` | `CreateProjectConnectionsInput` (`{connections: [{connectionId, key, name}] (1-10, one provider), settings}`) → `ProjectConnectionsResponse` (admin; all or none; 409 when a key is taken in the project, a connection is already in the project, or a source item scope such as a Jira project key belongs to a project connection of another project) |
| PATCH | `/projects/{id}/connections/{projectConnectionId}` | `UpdateProjectConnectionInput` (`{name?, settings?}`; the connection and the key never change) → `ProjectConnection` (admin) |
| DELETE | `/projects/{id}/connections/{projectConnectionId}` | → `{deleted: true}` (admin; 409 while a workflow or the project's current process uses the key; the organization connection stays) |
| GET / PUT | `/projects/{id}/runners` | → `ProjectRunners`; PUT `{runnerIds}` replaces them (admin; empty for none) |
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
| POST | `/workflow-runs/{runId}/cancel` | → `WorkflowRunDetail` (cancels active loops; the run's post action runs that have not started are skipped, and one that comes due later is skipped too, so a cancelled run no longer reports on its earlier events) |
| POST | `/workflow-runs/{runId}/retry` | → `WorkflowRunDetail` (admin; runs the step the run failed or was cancelled in again, see "Retrying a step"; 409 when `retryStep` is null or the step cannot start, e.g. its computer is offline) |
| POST | `/workflow-runs/{runId}/answers` | `{answers: [{id, answer}]}` → `WorkflowRunDetail` (any org member; the run must be `needs_input` on an agent step's questions not yet answered; 409 otherwise, 400 for an unknown or repeated question id) |
| POST | `/workflow-runs/{runId}/approval` | `{approved, comment?}` → `WorkflowRunDetail` (admin; the run must be `needs_approval` and undecided; 409 otherwise) |
| POST | `/workflow-runs/{runId}/review` | `DecideStepReviewInput` (`{decision: approve \| feedback \| reject, comment?}`) → `WorkflowRunDetail` (feedback: any member; approve and reject: admin; see "Review loops") |
| POST | `/workflow-runs/{runId}/tool-calls/{callId}/decision` | `{decision: approve \| reject}` → `WorkflowRunDetail` (admin; a `pending_approval` integration tool call, see "Integration tools") |
| GET / PUT | `/projects/{id}/process` | → `ProjectProcessState` (`current: null` = the built-in flow); PUT `{process}` saves a new version, `null` goes back to the built-in flow (admin; the toolkit must be one of the project's repositories, 400 otherwise) |
| GET | `/projects/{id}/process/versions` | → `ProjectProcessVersions` (newest first, ≤ 50) |
| POST | `/workflow-runs/{runId}/action-runs/{actionRunId}/retry` | → `WorkflowRunDetail` |
| GET | `/cron/workflows` | `Bearer CRON_SECRET` → tick counts |
| POST | `/desktop/integration-sessions` | `{actionRunId}` → `IntegrationSessionGrant`, the instruction agent's session token (runner API key; only the compute target the attempt was dispatched to) |
| POST | `/loops/{id}/integration-session` | → `IntegrationSessionGrant`, the STEP loop agent's session token (loop runner token; 404 when the step grants nothing) |
| GET | `/integration-tools/session` | `Bearer ist_…` → `IntegrationToolSessionDescriptor` (the session's tools and instructions) |
| POST | `/integration-tools/call` | `Bearer ist_…`, `IntegrationToolCallRequest` → `IntegrationToolCallResponse` |

Saving a workflow validates every trigger and action against the registry:
the connection exists in the org, the type belongs to the connection's
provider, and the config parses with the definition's schema (the parsed
config is stored). A **disabled** connection is accepted: it ignores inbound
events and its actions are skipped at run time, so disabling a connection
never blocks saving (or turning off) the workflows that use it. Pre actions
store `events = [workflow.triggered]`; post actions need at least one event
and may not use `workflow.triggered`. An action with `automaticConnection:
true` names no connection (`connectionId: null`) and needs one that the run
will have (see "Connection chosen by the run"); an instruction's
`config.instruction` must be 1-4000 characters and its connection must offer
operations. The order of actions in the request is their position, and error
messages name actions the way the editor does: "Action 2: …" (1-based in the
list); triggers are "Trigger 1: …". On update, an omitted `runAsUserId`
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

Both kinds of Cloud API token work. A token without scopes is used against
the site URL. A token **with scopes** (app Jira; `read:jira-user`,
`read:jira-work`, `write:jira-work`) only works through the Atlassian API
gateway: when the site answers `/myself` with 401, `validate` reads the
site's cloud id from `{siteUrl}/_edge/tenant_info` (unauthenticated) and
tries `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/myself`; on
success the cloud id is saved as `config.cloudId` (not on the form, never
taken from the submitted config) and every later REST call goes through the
gateway (`auth.ts` `jiraRestBaseUrl`). Browse links stay on the site URL.

Triggers:
- `jira.issue_assigned` — issue created with, or changed to, the bot as
  assignee (`changelog.items[].fieldId == "assignee"`, prefer
  `tmpToAccountId`). Filters: project keys, issue types, labels (any).
  `dedupKey = {issueKey}:assignee:{changelogId}` (`{issueKey}:created` on
  creation). Manual run with an issue key.
- `jira.issue_labeled` — a configured label added (`fieldId == "labels"`).
  `change: added` (default) `| removed | both` picks which side fires; removed
  labels are computed from the same changelog item as added ones. Removals are
  webhook only (poll never emits label events). If both the admin webhook and a Jira
  Automation rule deliver the same change, each delivery has its own dedup key
  and starts its own run.
- `jira.issue_status_changed` — the `status` changelog item (`fromString` /
  `toString` names) of an admin webhook, or an Automation body with
  `changelog.items`. Filters: `from`, `to` (any of, case-insensitive),
  `projectKeys`, `issueTypes`. `dedupKey = {key}:status:{changelogId |
  automation-{deliveryId}}`. Webhook only; the bot's own transitions are
  ignored; no manual run. A process-mode workflow gets one run per change; an
  orchestrated one gets a `status_changed` message on `jira:<KEY>:item`.
- `jira.issue_mentioned` — a comment (`comment_created` / `comment_updated`
  webhooks) or the description (on creation, or edited to newly mention it)
  mentions the bot: `[~accountid:…]` / `[~username]` wiki markup or ADF
  mention nodes. `dedupKey = {key}:mention:comment-{commentId}` or
  `{key}:mention:{changelogId}`. Webhook delivery only (Jira search cannot
  find mentions); select the Comment events on the admin webhook. The issue
  of a comment webhook carries only a few fields (no labels), so a comment
  that mentions the bot is followed by one `GET /issue/{id}?fields=…` for
  the filters (the webhook's fields are used if that read fails).
- `jira.issue_conditions` — combines **assigned to the bot**, **has one of
  the labels** and **the bot is mentioned** with `match: all` (AND) or `any`
  (OR), plus project, issue type and status filters
  (`apps/api/lib/integrations/trigger-conditions.ts`). Every occurrence that
  assigns the issue to the bot, adds labels or mentions the bot also emits
  one `jira.issue_conditions` event (`dedupKey = {key}:conditions:{changelogId
  | created | comment-{commentId} | automation-{deliveryId}}`) carrying the
  three facts and the issue state right after it (`assignedToBot`, `labels`).
  A run starts when the occurrence makes a chosen condition true and, with
  `all`, the other chosen conditions already hold, so "assigned AND labeled
  ai-ready" starts on whichever of the two happens second. A mention is a
  moment: with `all` the run starts on the mention while the other
  conditions hold. Poll mode emits these events for the assignments and
  label changes of issues assigned to the bot, with the state replayed from
  the changelog; mentions need webhooks.

```yaml
triggers:
  - connection: jira-shop
    type: jira.issue_status_changed
    config:
      from: [In Progress]       # any of, case-insensitive; omit for any
      to: [Done, Closed]
      projectKeys: [PROJ]
      issueTypes: [Story]
  - connection: jira-shop
    type: jira.issue_labeled
    config:
      label: create-prd         # one label per trigger
      change: both              # added (default) | removed | both
```

In an orchestrated workflow, `agent.orchestrator.cancelOn` (default
`[status_changed, label_removed]`, `[]` = never) lists the ticket changes whose
turn may cancel tasks with `task_cancel` (docs/orchestrator.md).

```yaml
triggers:
  - connection: jira-shop  # a project connection key
    type: jira.issue_conditions
    config:
      match: all            # all (AND) | any (OR)
      assigned: true        # assigned to the bot
      labels: [ai-ready]    # has one of these labels
      mentioned: false      # the bot is @mentioned
      projectKeys: [PROJ]
      statuses: [To Do]
```

Webhook bodies come from admin webhooks or from a Jira Automation "Send web
request" rule with the "Work item data (Jira format)" body (its numeric
epoch-millisecond dates are accepted; non-essential fields never reject a
delivery). Changing `siteUrl` or `deployment` requires re-entering the API
token. Rate limits, 5xx and timeouts while loading the issue raise
`RetryableSourceError`, so the import is retried.

Events caused by the bot itself are dropped (loop prevention). Poll uses JQL
`assignee = currentUser() AND updated >= "-Nm"` (`expand=changelog`), so it
only sees issues assigned to the bot: it emits `jira.issue_assigned` and
`jira.issue_conditions` events, never `jira.issue_labeled` or mentions. The
item is re-fetched with `expand=renderedFields`; HTML is converted to
markdown.

Actions: `jira.add_comment` (markdown → ADF on Cloud, plain text/wiki on
Data Center; target the source issue), `jira.transition_issue` (transition by
name, e.g. "In Review"), `jira.update_labels` (`add` / `remove` lists in one
`PUT issue` update; e.g. remove the label that started the run, as a pre
action) and `jira.add_link` (a remote link keyed by its URL, so adding it again
updates its title; e.g. the page the plan is reviewed on). All skip when the
run's source is not a Jira item. Importing an issue also reads its remote
links (`GET issue/{id}/remotelink`, best effort) as the item's links.
Attachments are imported as links only; an agent reads a text attachment
with `source_item_attachment_read`.

`jira.create_issue` is an external operation (agents get it with
`jira: { allow: [jira.create_issue] }` on the project connection key): a new
issue (`issueType`, default Story; `summary`; markdown `description`;
`labels`; a text file to attach, `attachmentName` + `attachmentContent`, e.g.
the full PRD next to a summary as the description) in one of the project
connection's `projectKeys` (default: the
source issue's project), optionally linked to another issue of those projects
(`linkIssue`, default the source issue). `linkType` is the phrase as read from
the new issue — the outward phrase or the type name ("implements") puts the
new issue at the inward end, the inward phrase ("is implemented by") at the
outward end — and is checked against `GET issueLinkType` before anything is
created. A description longer than a Jira field (30 000 characters; on Cloud,
of the ADF) continues in comments on the new issue, split at paragraphs
outside code blocks ("Description, continued (2/3)"). A retry looks for the bot's issue with the same summary created in
the last day before creating another; a link that fails after the issue was
created is final.

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
(@RecentMentions)`, best effort), `azure_devops.work_item_conditions`
(Boards rules: **assigned to the bot**, **has one of the tags** and **the
bot is mentioned**, combined with `match: all` or `any`, plus projects, work
item types, area path and states; same semantics as `jira.issue_conditions`;
`dedupKey = {id}:conditions:{rev}`; the state after an update comes from the
update's new values, else the service hook's revision snapshot, and in poll
mode is replayed back from the current work item through the updates' old
values).

Actions: `azure_devops.add_comment` (markdown comment),
`azure_devops.update_state`, `azure_devops.update_tags` (reads `System.Tags`,
removes case-insensitively, writes them back with a `test` of the revision
read, so a concurrent change fails retryably), `azure_devops.add_link` (a
`Hyperlink` relation with the title as its comment; skipped when the work item
already links the URL; its Hyperlink relations are the item's links),
`azure_devops.create_pull_request` (see
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
archives. Setup in [local-git.md](local-git.md). **Provided by the
server:** with `LOCAL_GIT_TOKEN` (and `LOCAL_GIT_SERVER_URL`,
`LOCAL_GIT_RUNNER_URL`, `LOCAL_GIT_OWNER`) on the API, every organization has
the Local Git connection without adding it (`server-connections.ts`: written
when the organization's connections are listed, under a per-organization
advisory lock, refreshed when the environment changes; recognised by
`createdById` null; a Local Git connection an admin added for the same server
and runner URLs is adopted, keeping its id). The provider summary and the connection carry
`providedByServer: true`; Add connection does not offer the provider, and
updating, deleting or creating one through the API is refused while the
server provides it. Connection: secret `token` (a
Gitea access token with `write:repository`, `write:organization`,
`write:user`, `write:issue`; `pnpm local-git:init` creates the account and the
token and writes it to `apps/api/.env.local`), config `serverUrl` (where the API reaches it, default
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

### Confluence (`confluence`)

Confluence Cloud, for agents and actions that publish and review documents
(`apps/api/lib/integrations/providers/confluence/`). No triggers, no inbound,
no source items: nothing starts a run from Confluence.

Connection: `siteUrl` (origin only; `/wiki` and any path are dropped), `email`
and secret `apiToken` of the bot account, Basic auth like Jira Cloud. A token
the site rejects (401) is tried through the Atlassian API gateway
(`https://api.atlassian.com/ex/confluence/{cloudId}`, the cloud id from
`/_edge/tenant_info`), where API tokens with scopes work, and `cloudId` is
saved. What Jira and Confluence share lives in `providers/atlassian/`
(`auth.ts`, the Markdown → ADF converter `adf.ts`). `validate` calls
`GET /wiki/rest/api/user/current`; the account id marks the bot's own comments
(`mine`). `siteUrl` is a credential origin field; a project connection may use
another account (email and token).

Project settings: `spaceKeys` (required) and `parentPageId` (where new pages
go). Spaces are not claimed (several projects may share one), and the project
connection's settings reach every operation (`ConnectionRuntime.projectSettings`):
each one resolves the page's space and refuses anything outside `spaceKeys`,
since a page link may come from untrusted ticket text. Used without a project
connection, nothing is allowed.

| Operation | Kind | What it does |
|---|---|---|
| `confluence.get_page` | read | A page by id or link on the site (`/wiki/spaces/{key}/pages/{id}`, `viewpage.action?pageId=`, short `/wiki/x/{code}` links): title, space, version, parent, URL and body as Markdown (from storage format) or `storage` (to edit it in place keeping macros and inline comment markers); bodies over 60 000 characters are cut (`truncated`). |
| `confluence.find_pages` | read | Pages whose title contains the words given, in the allowed spaces (CQL `title ~`), e.g. the plan page of a ticket. |
| `confluence.list_comments` | read | Footer comments and inline comments (with the highlighted text) of a page, each with its replies, `open` (unresolved) by default or `all`; each comment says whether the bot wrote it (`mine`). At most 50 threads. |
| `confluence.create_page` | write | A page in an allowed space, under `parentId` or the project's `parentPageId` (same space); Markdown is sent as ADF (`atlas_doc_format`), or `storage` as is. A retry finds the page its first attempt created. |
| `confluence.update_page` | write | New body (and title) from `baseVersion`, the version read: refused when the page is at another version (or Confluence answers 409), so a reviewer's edit is never overwritten. |
| `confluence.comment` | write | A comment below the page, or a reply (`replyTo`) to a footer or inline comment of that page. |
| `confluence.resolve_comment` | write | Resolves an inline comment of the page (its body is sent back unchanged); a resolved one is not an error. |

Reads are agent tools on any granted key (`wiki: read`); writes are granted by
name (`wiki: [confluence.update_page, confluence.comment]`) and are typed
workflow actions too, e.g. publish a plan with `confluence.create_page` on
`plan.completed`. Plans stay in AgentFlow unless a workflow grants or adds
these writes.

### Microsoft Teams (`microsoft_teams`)

One connection, two independent parts (at least one set):

- **Workflows webhook** — secret `webhookUrl`, a Teams **Workflows** webhook
  ("When a Teams webhook request is received", *Send webhook alerts to a
  channel* template). Office 365 connector webhooks were retired in 2026 and
  are rejected. `validate("test")` posts a test card.
- **Bot** — config `appId`, `tenantId` (an Azure Bot, single tenant) and
  secret `clientSecret`. `validate` signs the bot in (client credentials,
  Bot Connector scope; "test" also gets a Graph token); the account is
  `28:{appId}`. Delivery mode **webhook**: the inbound URL is the Azure Bot's
  messaging endpoint (public HTTPS; behind NAT use a tunnel such as
  `cloudflared` and `PUBLIC_WEBHOOK_BASE_URL`). The inbound secret is unused:
  `verify` checks the Bot Framework JWT (issuer `https://api.botframework.com`,
  audience the App ID, RS256 key from the Bot Framework's OpenID metadata,
  endorsed for `msteams`, `serviceurl` claim = the activity's serviceUrl).
  The Teams app manifest (template in the setup instructions) grants the RSC
  permission `ChannelMessage.Read.Group`.

Project settings: `channels` (links or ids, stored lower-cased); scope
`microsoft_teams:{tenantId}:{channelId}`. No channels: post-only.

Trigger `microsoft_teams.bot_mentioned` — a `message` activity in a channel
of the bot's tenant that @mentions the bot (new post or thread reply; group
and personal chats, other tenants and the bot's own messages are ignored).
Filter: `channels` (empty = all of the project connection). The item is the
**thread**: key `teams-{hash(channel, root)}` (one run per thread; another
mention resumes a `needs_input` run), externalId
`{teamGroupId}|{channelId}|{rootId}|{messageId}`, dedupKey
`{conversationId}:mention:{messageId}`. Extras (`run.sourceExtras`):
`teamsServiceUrl`, `teamsConversationId`, `teamsRequesterId`,
`teamsRequesterName`.

Source: `fetchItem` reads the root post and up to 500 replies through Graph
(`/teams/{id}/channels/{id}/messages/{id}[/replies]`). Description = the
message that mentioned the bot, without the mention (the request);
section **Teams thread** = the whole thread oldest first (oldest replies
dropped above 60 000 characters); reporter = who mentioned the bot.
Anyone in the channel can ask; thread text is untrusted input like ticket
text.

Actions: `microsoft_teams.post_message` (webhook) — Adaptive Card 1.4 with
title, markdown text, facts (status, source, PR) and "Open …" buttons.
`microsoft_teams.reply` (bot, `sourceOperation: comment`, so agents get it
through `source: [comment]`) — a markdown message in the source thread,
optionally starting with an @mention of the requester; the token is only sent
to Teams Bot Connector hosts (`smba.trafficmanager.net`,
`smba.infra.*.teams.microsoft.{com,us}`); skipped for runs not from Teams.

### Webhook (`webhook`)

Built in, not an integration: it is not offered in Settings → Connections.
Every workflow can use it as its **HTTP request** trigger and as an **HTTPS
request** pre/post action, both written `connection: http` in the workflow
YAML. Saving the workflow creates one webhook
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

The PRD instruction (`agent.prd.instruction`) reads the request's `type` and
`labels` like any item's: with "PRD when the type is prd", such a request is
imported as a PRD instead of an Issue, the description is the PRD's body and
the plan is generated from it. Without an instruction it is an Issue.

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

Project → Integrations (a tab on the project page) lists the project's
repositories and adds new ones: pick a connection whose provider has the
`repositories` capability, search the repositories it can access, add.
Adding and removing repositories are org-admin
operations, because agents push to these repositories with the connection's
credentials. A repository stores no token. Deleting its connection is refused
while a project uses it; a repository whose connection is gone shows
"Connection removed".

Pull requests are **workflow actions**, never implicit: add "Create pull
request" (`github.create_pull_request`, `azure_devops.create_pull_request`)
as a post action on `workflow.completed`, on the connection that owns the
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
- **Runners.** Project → Integrations → Runners lists the computers the
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
| `LOCAL_GIT_TOKEN` | unset | Local Git access token: every organization gets the Local Git connection |
| `LOCAL_GIT_SERVER_URL` | `http://localhost:3300` | Where the API reaches Local Git |
| `LOCAL_GIT_RUNNER_URL` | the server URL | Where runners reach Local Git |
| `LOCAL_GIT_OWNER` | unset | Local Git organization of the repositories |
| `WORKFLOW_TICK_SECONDS` | `10` | Scheduler tick for workflows |
| `WORKFLOW_RUN_PHASE_TIMEOUT_HOURS` | `24` | Fail runs stuck in planning/executing |
| `CRON_SECRET` | ephemeral | Bearer for `/cron/*` |
| `SELF_HOSTED_CRON_DISABLED` | unset | `true` disables the in-process runner |
| `NEXT_PUBLIC_APP_URL` | — | Base of links in post actions |
| `SMTP_URL` | unset | Mail relay of `agentflow.email` actions (and auth mail); unset skips them |
| `EMAIL_FROM` | `AgentFlow <no-reply@localhost>` | Sender of that mail |

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
- Members who are not org admins cannot read connections or project
  connections, and see url-kind config values of workflows (outbound webhook
  targets, callback URLs) as their origin only.
- Connection and workflow changes, project repository changes, manual runs,
  cancel and retry require org admin. Listing a connection's repositories is
  admin-only too (it uses the connection's token). Loops run as the workflow's run-as user on a compute target that user
  can access; a workflow that runs as someone other than the admin who saved
  or enabled it may only use a target shared with the org.
- Bot loop prevention: providers drop events caused by the bot account.
