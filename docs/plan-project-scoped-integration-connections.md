# Plan: Integration MCP for agents + connections in workflows and processes

Status: in progress · 2026-10-13 (as-built differences checked 2026-10-19)

> **Changed 2026-10-19:** project connections no longer take an account of
> their own. An organization connection is one account (one bot), added to a
> project at most once; one bot per workflow means one connection per bot,
> added together with the same settings (docs/workflows.md "One bot per
> workflow"). Migration `20261019110000_project_connection_accounts_as_connections`
> moved existing own accounts to connections of their own. The account
> override, its polling and its admin API below are history.

| Rollout step | State |
|---|---|
| 1. Foundation | Done: schema, admin API/UI, conflict checks, runtime, polling per account. |
| 2. Part 2 for triggers and typed actions | Done: keys, root/trigger `project:`, validation, editor, pinning. |
| 3. Part 1 for instructions | Done: `ist_` sessions (stored hashed, bound to attempt + computer), `/desktop/integration-sessions`, `/integration-tools/{session,call}`, `apps/mcp` integration sessions, generic source tools + one tool per granted external operation, runner MCP config with `--strict-mcp-config`, operations JSON replaced. Differences from §1.2–1.4: opaque tokens instead of signed ones; generic `<provider>_<operation>` tools from the action definitions instead of hand-written `jira_*` tools; no version gate (runners build from this repo). |
| 4. Agent-step grants in process loops | Done: STEP loops of a step with a grant get a session (loop-runner token, `POST /loops/{id}/integration-session`), the runner adds the MCP config to the loop's agent; `connection_get_item` reads granted connections within their containers; the process editor completes `connections:`. Not done: Jira/ADO create and search tools (no create operations exist yet). |
| 5. Approval, created items | Approval done: `approval: required` writes wait as `pending_approval`, org admins approve/reject on the run page. Created items (`as`, `{{created.*}}`) wait for a creating operation. |

### As built: differences from the design below

The sections below are the design as written on 2026-10-13. Where the code
differs, the code (and `docs/workflows.md`, which describes it) is right:

- **Tables.** No `IntegrationOperationCall` and no `WorkflowRunCreatedItem`.
  Sessions are `IntegrationToolSession` (`integration_tool_sessions`: run,
  action run + attempt or loop, step, compute target, hashed opaque token,
  expiry) and calls `IntegrationToolCall` (`integration_tool_calls`: session,
  tool, operation type, connection key, input, status `running | succeeded |
  failed | refused | pending_approval | rejected`, idempotency key, decider).
  Created items (`as`, `{{created.*}}`) are not built.
- **Workflow references.** `WorkflowTrigger` and `WorkflowRun` carry
  `projectConnectionId` (trigger: `Restrict`; run: `SetNull`). `WorkflowAction`
  has no foreign key: it stores the key (`connection_key`), resolved in the
  run's project when the action runs; `connection_id` is only the workflow's
  built-in HTTPS call.
- **Migration.** `20261013110000_workflow_project_connections` deletes the
  workflows (cascading triggers, actions, runs, deliveries). Project
  repositories are kept; they still reference the organization connection.
- **Admin API.** The account override is part of
  `PATCH /projects/{id}/connections/{projectConnectionId}` (`override`, `null`
  goes back to the connection's account); there are no `PUT/DELETE …/override`
  routes. Delete is refused while a workflow (any, not only enabled ones) or
  the project's current process uses the key. Providers with an account
  override: Jira, Azure DevOps, Confluence.
- **Tools.** Generic tools built from the action definitions, not hand-written
  per provider: `integrations_overview`, `source_item_get / comment /
  transition / label / link`, `connection_get_item`, `<provider>_<read>`
  (Confluence reads), `<provider>_<operation>` (e.g.
  `microsoft_teams_post_message`, `webhook_post`, `azure_devops_run_pipeline`)
  and the pull request review tools (`pull_requests_list`,
  `pull_request_threads`, `pull_request_reply`, `pull_request_resolve`). No
  `jira_*` / `azure_devops_*` create or search tools (no create operations
  exist). Catalog: `apps/api/lib/integrations/agent-tools/catalog.ts`.
- **Tokens.** Opaque `ist_` tokens stored hashed, not signed JWTs; no runner
  version gate (runners build from this repo).
- **`apps/mcp`.** Integration sessions live in `apps/mcp/src/integration-session.ts`
  (no `tools/integration-tool.ts`).
- **Runner.** Instructions run with `--strict-mcp-config`; STEP loops add the
  `agentflow_integrations` server next to their own MCP servers, without
  `--strict-mcp-config` (`apps/desktop/src/server/operations/loop-step.ts`).
- **Teams.** Not one connection per channel: a project connection lists its
  `channels` (scope `microsoft_teams:{tenantId}:{channelId}`).
- **YAML.** Trigger and action options stay under `config:` (the §2.5 examples
  below are written that way now). The editor helpers named in §2.9
  (`WorkflowYamlIntro`, `WorkflowYamlProblems`) were replaced by the
  configuration guide (`workflow-configuration-guide.tsx`, texts in
  `workflow-yaml-docs.ts`) and inline problems (`workflow-yaml.ts`).

This plan has two parts on top of one shared foundation:

- **Foundation — Project connections.** Org admins own connections; projects use them under a
  stable key, with project settings and an optional own account.
- **Part 1 — Integration MCP for runner agents.** Agents on runners interact with integrations
  (Jira, Azure DevOps, Teams, webhooks) only through MCP tools with precise descriptions. The
  "agent answers with an operations JSON, the API carries it out afterwards" flow is replaced.
- **Part 2 — Connections in workflows and processes.** How triggers, actions, instructions and
  process agent steps refer to connections, which connection every operation uses, and the guards
  that make a wrong connection impossible.

## Today

- Credentials are sealed in `integration_connections` and decrypted only in `apps/api`
  (`loadConnectionRuntime()`, `apps/api/lib/integrations/connection-service.ts`).
- Instruction actions (`apps/api/lib/workflows/engine/instruction-action.ts`): the API dispatches a
  command to the runner (`dispatchWorkflowInstruction`, `apps/api/lib/loops/loop-desktop.ts`); the
  runner runs Claude read-only (`apps/desktop/src/server/operations/workflow-instruction.ts`,
  `INSTRUCTION_ALLOWED_TOOLS`); the agent's final answer is a JSON list of operations; the API checks
  them (`planOperations`, `checkOperation`) and carries them out. The agent cannot read Jira itself
  and cannot see the effect of an operation before it finishes.
- Process agent steps (loops) have no integration access at all.
- `apps/mcp` exists (documents, projects, loops…) and authenticates with the user's API key or an
  OAuth token. It has no integration tools.
- Connections are org-level only; workflow YAML refers to them by org connection name or id.

## Decisions

| Topic | Decision |
|---|---|
| Ownership | Org connection = site, deployment, default account. Project connection = a use of an org connection in a project: key, display name, settings, optional own account. |
| Visibility | Connections and project connections are managed and seen by **org admins only**, reads included (today connection reads are open to members, `apps/api/app/integrations/connections/route-helpers.ts`). |
| Multiplicity | Any number of project connections per project, also of the same provider and of the same org connection (same Jira site, two accounts). |
| Reference | Project connection **key** (slug `^[a-z][a-z0-9-]{1,39}$`, e.g. `jira-billing`), unique per project, immutable; display name free to rename. Never the Jira project key: connections are not only Jira, one connection can hold several Jira keys, two sites can share a key. |
| Shared bot / override | Default: the org connection's account; projects differ by settings (Jira project keys). A project connection may use its own account (Jira email + API token / PAT, ADO PAT, repository token) when the bot cannot be added. Site and deployment always come from the org connection. |
| Workflow project | Every trigger has a project: `project:` at the root (default for all triggers) or on the trigger (overrides the root). A trigger without either fails validation. The run's project is its trigger's project; connection keys resolve in that project. |
| Uniqueness | No conflicts allowed: an item-source scope (Jira site + project key, ADO organization + project) belongs to **at most one** project connection in the whole org, whatever the account; the same org connection without override is bound at most once per project. Every incoming item therefore maps to exactly one project connection. |
| Default agent rights | **Read-only.** Instructions and agent steps read the source item only; every write (also on the source item) must be listed in the workflow/process (`connections:` grants). Typed actions are writes the admin wrote, so they need no grant. |
| Runners | All agents run in runners. Headless runners are fully isolated from their host (no host config, credentials or MCP servers); the agent gets exactly the MCP servers the runner passes. The desktop app (uses the host machine) is out of scope for now. |
| Existing data | Development phase: no backfill. The migration deletes existing workflows (with triggers, actions, runs, deliveries) and project repositories; org connections are kept. |
| Trigger filters | A Jira trigger's `projectKeys` ⊆ its project connection's keys; empty = all keys of the project connection (not "any project"). Enforced at save and at match time. |
| Agent access | Agents reach integrations **only through MCP tools**. No credentials on the runner, no operations JSON. |
| Tool list | Per session, built by the API from the action/step **grants**: an agent only sees the tools it may call, with the allowed connection keys as enums in the input schema. |
| Tool definitions | Declared in code per provider (name, description, input schema, target, annotations). Never generated when a connection is added. Descriptions are completed per session with concrete facts (source item, granted connections, fixed values). |
| Authority | Comes from the workflow/process configuration an admin wrote, carried by a short-lived **integration session token** per action run / loop — not from the user's API key. Members whose runs use a project connection never see its configuration. |
| Connection choice | Source pinning, explicit grants, choose only within grants (Part 2 §2.3). Same model for every provider. |
| Editor | Full autocomplete, live diagnostics, hover and an on-page guide in the workflow and process YAML editors (Part 2 §2.9). |

---

## Foundation — Project connections

### F.1 Data model (`packages/database/prisma/schema.prisma`)

```prisma
model ProjectConnection {
  id             String   @id @default(uuid(7)) @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  projectId      String   @map("project_id") @db.Uuid
  connectionId   String   @map("connection_id") @db.Uuid
  // Stable reference used by YAML, grants and MCP tools: slug, unique per project, immutable.
  key            String   @db.VarChar(40)
  // Display name; free to rename.
  name           String   @db.VarChar(120)
  // Provider-validated project settings, e.g. Jira { projectKeys: ["ABC"] }.
  settings       Json     @default("{}")
  // Account override. Null credentials = the org connection's account.
  overrideConfig       Json?     @map("override_config")        // e.g. Jira { email, cloudId }
  credentialsEncrypted String?   @map("credentials_encrypted") @db.Text  // SecretPurpose.IntegrationCredentials
  credentialHints      Json      @default("{}") @map("credential_hints")
  account              Json?                                     // IntegrationAccount of the override
  status               String    @default("active") @db.VarChar(16)  // IntegrationConnectionStatus
  lastValidatedAt      DateTime? @map("last_validated_at")
  lastError            String?   @map("last_error") @db.Text
  // Poll state when the project connection has its own account.
  pollCursor           Json?     @map("poll_cursor")
  nextPollAt           DateTime? @map("next_poll_at")
  lastPolledAt         DateTime? @map("last_polled_at")
  createdById    String?  @map("created_by_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  // relations: organization, project (Cascade), connection (Cascade), createdBy (SetNull),
  // triggers, actions, runs, createdItems, operationCalls
  @@unique([projectId, key])
  @@index([organizationId, connectionId])
  @@index([nextPollAt])
  @@map("project_connections")
}

model WorkflowRunCreatedItem {
  id                  String   @id @default(uuid(7)) @db.Uuid
  organizationId      String   @map("organization_id") @db.Uuid
  runId               String   @map("run_id") @db.Uuid
  projectConnectionId String   @map("project_connection_id") @db.Uuid
  name                String?  @db.VarChar(64)             // `as`, for {{created.<name>}}
  itemKey             String   @map("item_key") @db.VarChar(255)
  externalId          String   @map("external_id") @db.VarChar(255)
  url                 String?  @db.Text
  createdAt           DateTime @default(now()) @map("created_at")

  @@unique([runId, name])
  @@map("workflow_run_created_items")
}

model IntegrationOperationCall {
  id                  String   @id @default(uuid(7)) @db.Uuid
  organizationId      String   @map("organization_id") @db.Uuid
  runId               String   @map("run_id") @db.Uuid
  actionRunId         String?  @map("action_run_id") @db.Uuid
  loopId              String?  @map("loop_id") @db.Uuid
  projectConnectionId String   @map("project_connection_id") @db.Uuid
  tool                String   @db.VarChar(64)
  input               Json                                  // secrets scrubbed
  // IntegrationOperationCallStatus: succeeded | failed | refused | pending_approval | rejected
  status              String   @db.VarChar(24)
  output              Json?
  error               String?  @db.Text
  idempotencyKey      String   @unique @map("idempotency_key") @db.VarChar(255)
  createdAt           DateTime @default(now()) @map("created_at")

  @@index([runId, createdAt])
  @@map("integration_operation_calls")
}
```

- `WorkflowTrigger`, `WorkflowAction`, `WorkflowRun` get `projectConnectionId` (FK, `Restrict`,
  indexed). On `WorkflowRun` it is the **source** project connection. `connectionId` stays (org
  paths, deliveries) and must equal the project connection's.
- `WorkflowTrigger.projectId` (FK, indexed): the trigger's project (root `project:` or its own).
  `Workflow.projectId` stays as the root default; `WorkflowRun` records the trigger's project.
- `ProjectConnectionScope` (`organizationId`, `projectConnectionId`, `scopeKey` **unique per org**):
  one row per item-source scope of a project connection, e.g. `jira:<site>:ABC`,
  `azure_devops:<org url>:<project>`. Written with the settings in one transaction; P2002 → 409
  naming the project connection that owns the scope. It is also the routing table for incoming
  items (scope → project connection).
- Migration `--create-only`, applied only with explicit go-ahead. No backfill (development
  phase): it deletes existing workflows (cascading triggers, actions, runs, deliveries) and project
  repositories, keeps org connections. Migration tests for every new index/FK/unique
  (packages/database AGENTS.md); seed updated.

### F.2 Provider definition additions (`apps/api/lib/integrations/types.ts`)
- `projectSettings?: { schema; fields }` — Jira `{ projectKeys }`; Azure DevOps `{ projects,
  areaPaths? }`; repository providers: repositories; Teams/Webhook: none.
- `accountOverride?: { fields }` — Jira email + API token / PAT; ADO PAT; Bitbucket/GitHub token.
- `IntegrationActionDefinition.target: source_item | repository | external` (Part 2 §2.2).
- `agentTools: IntegrationAgentToolDefinition[]` (Part 1 §1.3).

### F.3 Effective connection
- `loadProjectConnectionRuntime(organizationId, projectConnectionId)`: org runtime, then override
  config/secrets/account when the override is active, plus parsed settings. Used by every
  project-scoped path (source fetch, actions, MCP tools, override polling).
- Saving an override runs the provider's `validate()` with the merged config (Jira `/myself`, API
  gateway fallback, `cloudId` stored in `overrideConfig`). Merge/clear semantics and hints reuse
  `connection/secrets.ts`.
- Changing a credential-origin field of the org connection (`JIRA_CREDENTIAL_ORIGIN_FIELDS`) sets
  its overrides to `error` ("re-enter the token"): a token never reaches a site it was not entered
  for.
- Identity checks (`providers/jira/identity.ts`: assigned-to-bot, mentions, own comments) use the
  effective account.
- Polling is per account (`assignee = currentUser()`): the org connection polls for project
  connections without an override; each override polls with its own runtime and cursor and feeds
  only workflows using it. Webhooks stay per org connection. Every item is routed through
  `ProjectConnectionScope` (site + project key → exactly one project connection); items whose scope
  has no owner are ignored.

### F.4 Admin API and UI
- `apps/api/app/projects/[id]/connections/` (admin only): `GET`, `POST { connectionId, key, name,
  settings, override? }`, `[pcId]` `PATCH { name, settings }` (key immutable), `PUT/DELETE
  override`, `DELETE` (409 while used by enabled workflows or the current process version, listing
  them). P2002 on `(projectId, key)` → 409. Conflicts are refused on create/update (409 with the
  conflicting project connection): a scope already owned elsewhere (`ProjectConnectionScope`), or
  the same org connection without override already bound in the project. Service `project-connection-service.ts`, `withDb`,
  org-scoped, `Result` errors.
- `apps/api/app/integrations/connections/[id]/projects` `GET`. All `/integrations/connections*`
  reads become admin-only (`denyUnlessOrgAdmin`), member DTO variant dropped.
- UI: Org Settings › Integrations gets "Used by projects"; Project settings gets an "Integrations"
  panel next to `project-repositories-panel.tsx` (admins only): connection, name, key (prefilled
  from the name, read-only after creation, copy button), project settings, "Use a different
  account" (warns that comments/transitions appear as that person). Fetched when the panel opens.
- Renaming changes only the display name; to change a key, create a new project connection and
  move workflows to it.

---

## Part 1 — Integration MCP for runner agents

### 1.1 Flow

```
API (dispatch action run / loop)
  └─ command to runner: { actionRunId | loopId, ... }              (no token in the command)
runner
  ├─ POST /desktop/integration-sessions { actionRunId | loopId }   (runner auth + computeTargetId)
  │     → { token: "ist_…", expiresAt }                            (API checks the run is on this runner)
  └─ spawns the agent with an MCP config: agentflow_integrations → MCP URL, Bearer ist_…
agent ──tool call──> apps/mcp ──> apps/api /integration-tools/* ──> provider (Jira, ADO, Teams…)
                                     └─ grants, pinning, settings, approval, idempotency, audit
```

`apps/mcp` stays a thin forwarder (no DB, no credentials), exactly like the document tools.

### 1.2 Integration session token
- Minted by `POST /desktop/integration-sessions`, authenticated as the runner (same auth as the
  other `/desktop/*` routes, `requireComputeTargetId`); the action run / loop must be dispatched to
  that compute target and running.
- Signed token `ist_<jwt>` (key rotation like the MCP OAuth signing keys): `{ org, runId,
  actionRunId | loopId, stepId?, exp }`. Expiry = the action/step timeout + margin.
- **Grants are not in the token.** Every call re-reads them from the run snapshot (the workflow /
  process version the run started with) and checks the action run / loop is still running —
  ending, cancelling or failing it revokes the token immediately.
- The token only authorizes `/integration-tools/*` of its run; it is rejected everywhere else.
- It is the **only** way to integration tools: agents run only in runners, so there is no other
  client. User API keys and OAuth sessions of `apps/mcp` get no integration tools.
- On the runner the token lives only in the agent's process env (`AGENTFLOW_INTEGRATION_TOKEN`,
  referenced from the MCP config as `${AGENTFLOW_INTEGRATION_TOKEN}`) — never in the prompt, the
  workspace or the command store. An agent with Bash could read it; it then has exactly the rights
  of its tools, for the lifetime of the step.

### 1.3 Tool definitions (`apps/api/lib/integrations/providers/<key>/agent-tools.ts`)

```ts
export type IntegrationAgentToolDefinition<TInput> = {
  name: string;                        // MCP tool name, e.g. "jira_create_issue"
  title: string;                       // "Create a Jira issue"
  target: IntegrationOperationTarget;  // source_item | external
  access: IntegrationToolAccess;       // read | write
  /** Static description, written to the rules in §1.5. */
  description: string;
  /** Session facts appended to the description (source item, connections, fixed values). */
  describeForSession?(session: AgentToolSession): string;
  /** Input schema for this session: connection enum, fixed values removed, known values listed. */
  inputSchema(session: AgentToolSession): z.ZodType<TInput>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean;
                 openWorldHint: boolean };
  /** Provider operation it performs, for grants (`allow: [jira.create_issue]`); none for reads. */
  operationType?: string;
  execute(ctx: AgentToolContext<TInput>): Promise<Result<AgentToolOutput, AgentToolError>>;
};
```

`AgentToolSession` = run source (provider, item key, title, source project connection), the grants
of the action/step resolved to project connections, their settings and fixed `with` values. Typed
actions and tools share one implementation per operation (e.g. `jiraTransitionIssueAction`'s
logic is reused by `source_item_transition` for Jira).

### 1.4 Tool catalog

Generic `source_item_*` tools work for any source provider, so the agent does not need to know
whether the ticket came from Jira or Azure DevOps. They take neither an item nor a connection.

| Tool | Access | Registered when | Purpose |
|---|---|---|---|
| `integrations_overview` | read | always | What this session may do: source item, granted connections with their tools and fixed values, approval rules. |
| `source_item_get` | read | run has a source item | Fields, description, recent comments, available transitions/states, URL. |
| `source_item_comment` | write | `source: [comment]` granted | Comment on the source item. |
| `source_item_transition` | write | `source: [transition]` granted | Move the source item (Jira transition / ADO state). |
| `jira_get_issue`, `jira_search_issues` | read | a Jira connection granted `read`+ | Read other issues within the connection's `projectKeys` (JQL wrapped as `project in (…) AND (…)`). |
| `jira_create_issue` | write | `jira.create_issue` granted | Create an issue; `as` names it for `{{created.<as>}}`. |
| `jira_comment_issue`, `jira_transition_issue` | write | granted | Comment on / move **another** issue; key checked against `projectKeys`. |
| `azure_devops_get_work_item`, `azure_devops_query_work_items` | read | ADO connection granted `read`+ | Read within the connection's `projects`. |
| `azure_devops_create_work_item` | write | granted | Create a work item. |
| `azure_devops_run_pipeline` | write | granted | Queue a pipeline (pipeline fixable with `with`). |
| `teams_post_message` | write | `microsoft_teams.post_message` granted | Post to a granted Teams channel. |
| `webhook_post` | write | `webhook.post` granted | POST JSON to a granted webhook connection. |

Not agent tools: pull requests (`*.create_pull_request` need the pushed branch state; they stay
typed post actions) and anything on connections that are not granted.

### 1.5 Descriptions that make the agent pick the right tool

Rules, checked by a unit test over every tool definition:
1. First sentence: what it does, with its object ("Move the item this run started from to another
   status.").
2. `Use when:` one or two concrete situations. `Do not use for:` the nearest wrong choice and the
   tool to use instead (`source_item_transition` ↔ `jira_transition_issue`).
3. Every restriction the server enforces is stated (pinned item, granted connections, project keys,
   fixed values, approval), so a refusal never surprises the agent.
4. What it returns and how to refer to the result later (`as`, `{{created.*}}`).
5. Each parameter has a description and an example; enums for connections, and for issue types /
   transitions where known; never a free-text `connection`.
6. No secrets, credential URLs or account details.
7. Length caps (1200 chars static + 600 session facts).

Example — `source_item_transition`, run from Jira:
```
Move the item this run started from to another status.
Use when: the instruction asks to move "the ticket"/"this issue" (e.g. to In Progress or Done).
Do not use for: any other issue, even one mentioned in the ticket text — use
jira_transition_issue (only available when granted).
The item is fixed by the server and cannot be changed.
This session: Jira issue JA-7 "Login fails on Safari" via connection `jira-customer`.
Transitions: Start Progress → In Progress, Resolve → Done (source_item_get refreshes them).
Input: transitionName — transition or status name, case-insensitive. Example: "In Progress".
Returns: the new status.
```

Example — `jira_create_issue` with grant `jira-internal: { allow: [jira.create_issue], with:
{ projectKey: OPS, issueType: Task } }`:
```
Create a new Jira issue in a connection this session may write to.
Use when: the instruction asks for follow-up work tracked elsewhere (e.g. a QA task).
Do not use for: updating the ticket this run started from (use source_item_comment /
source_item_transition).
Allowed here: connection `jira-internal` (projects: OPS). Fixed by the workflow: projectKey=OPS,
issueType=Task — they are not parameters.
Input: connection ("jira-internal"), summary, description (Markdown), as (optional name).
Returns: issue key and URL; with as: "qa_ticket", later actions can use {{created.qa_ticket}}.
```

- Per-session MCP server `instructions` (sent on `initialize`), generated from the session: the run,
  the source item, the granted connections, what the agent may and may not do, and "the server
  rejects anything outside these grants; do not try other connections". The instruction prompt
  (`buildInstructionPrompt`) and the loop context pack include the same block.
- Errors are actionable and list alternatives: `Not allowed: jira.create_issue on jira-customer is
  not granted for this action. Granted: jira-internal.`

### 1.6 API routes (`apps/api/app/integration-tools/`)
- `GET /integration-tools/session` (session token) → `{ instructions, tools: [{ name, title,
  description, inputSchema (JSON Schema via z.toJSONSchema), annotations }] }`, already filtered and
  completed for the session.
- `POST /integration-tools/call { tool, input, callId }` (session token) → resolve the tool, apply
  Part 2 §2.3–2.4, `loadProjectConnectionRuntime()`, execute, record `IntegrationOperationCall`,
  scrub secrets (`scrubProviderError`), return `{ ok, output }` or `{ ok: false, error, retryable }`.
- Thin routes, logic in `integration-tool-service.ts` (+ `service/` helpers); `Result` errors; a
  per-session call budget (rate limit per action run / loop).

### 1.7 `apps/mcp`
- Accept `ist_` bearer tokens next to `sk_live_` / `mcp_at_` (`index.ts`). For such a session,
  `createMcpServer()` registers **only** the tools returned by `/integration-tools/session`, with its
  `instructions` (no document/project tools).
- Cache the descriptor per token for its lifetime (stateless mode rebuilds the server per request);
  calls always go to the API, which re-checks grants.
- One generic forwarding registration (`tools/integration-tool.ts`) with `ApiClient` and
  `withErrorHandling`; annotations passed through.
- User API keys / OAuth sessions get no integration tools.

### 1.8 Writes: idempotency, approval, audit
- `idempotencyKey` = action run / loop + tool + normalized input (+ MCP `callId`); a repeated call
  returns the first result instead of writing twice.
- Creating tools also write `WorkflowRunCreatedItem`.
- `approval: required` grants: the call returns `{ status: "pending_approval" }` and the agent is
  told not to retry; the run page shows Approve/Reject; an approved call executes then.
- Once any write of an action run succeeded the action is not retried (today's rule), now tracked
  through `IntegrationOperationCall`.
- Run page: every call with tool, connection key, input summary, result or refusal reason.

### 1.9 Runner changes (`apps/desktop`)
- `workflow-instruction.ts` and the loop launcher get the session token (§1.2), write a temp MCP
  config (`mcpServers.agentflow_integrations`, `type: http`, URL, header `Authorization: Bearer
  ${AGENTFLOW_INTEGRATION_TOKEN}`) and pass `--mcp-config <file>`. Instructions also pass
  add `mcp__agentflow_integrations__*` to `INSTRUCTION_ALLOWED_TOOLS`
  (still no Write/Edit/Web). Codex harness: equivalent `mcp_servers` entry with
  `bearer_token_env_var`.
- MCP URL from runner config (`AGENTFLOW_MCP_URL`, self-hosted default from `docker-compose.yml`).
- Headless runners are isolated from their host: `--strict-mcp-config` for instructions **and**
  loops, so the agent gets only `agentflow_integrations` (plus servers the runner itself bundles,
  e.g. Playwright for visual QA), never host configuration.
- Older runners: the dispatch carries `integrationMcp: true`; the API refuses to dispatch an
  instruction/step with integration access to a runner whose version lacks support, with a clear
  error.

### 1.10 Replacing the operations-JSON flow
- The agent acts through tools; its final answer is a short summary. `workflowInstructionResultSchema`
  (`packages/api/src/types/workflow-instruction.ts`) drops `operations`, keeps `summary`;
  `planOperations` / `checkOperation` move into the call path of §1.6.
- `buildInstructionPrompt` drops the operations list/format and adds the session block of §1.5.
- One cutover, behind the runner version gate.

---

## Part 2 — Connections in workflows and processes

### 2.1 References
Every trigger has a project: root `project:` is the default, a trigger's own `project:` overrides
it; a trigger with neither fails validation. Every `connection:` / `connections:` value is a
**project connection key** of the trigger's project (actions and process steps: the key must exist
in every project the workflow's triggers use); `source` is a reserved alias for the run's source
connection. Stored as `projectConnectionId`, serialized back as the key.

### 2.2 Operation targets

| Target | Examples | Connection |
|---|---|---|
| `source_item` | `jira.add_comment`, `jira.transition_issue`, `azure_devops.add_comment`, `azure_devops.update_state` | Pinned to the run's source |
| `repository` | `github` / `bitbucket` / `local_git` / `azure_devops` `.create_pull_request` | The connection owning the repository (`ProjectRepository`) |
| `external` | `jira.create_issue`, `azure_devops.create_work_item`, `azure_devops.run_pipeline`, `microsoft_teams.post_message`, `webhook.post` | Explicit `connection:` or grant |

Provider notes: Teams — one connection per channel, keys tell them apart, no override. Azure
DevOps — `projects` limits work items and repositories. Repository providers — current
`ProjectRepository` flow, now with a key and an optional own token. The built-in HTTP trigger stays
workflow-owned.

### 2.3 The three rules
1. **Source pinning.** A run records its source project connection (trigger, or the item chosen on
   "Run now"). `source_item` operations always run on it; naming another connection for the source
   item is rejected, never re-routed.
2. **Agents are read-only unless the workflow says what they may write.** Instructions and agent
   steps can read the source item only. Every write needs a grant listing it: on the source item
   (`source: [comment, transition]`) or on another connection (`jira-internal: [jira.create_issue]`).
   Typed actions are writes the admin wrote; their `connection:` (or the source, for `source_item`
   types) is the grant.
3. **Choose only within grants.** A tool or typed action without a connection resolves to the source
   (`source_item`) or to the single grant allowing the operation; zero or several → rejected with the
   list of keys. Connections are never inferred from item keys.

### 2.4 Guard details
- `source_item` tools and actions have **no item parameter**; the item is `run.source.externalId`, so
  item keys in ticket text (title, description, comments) can never redirect them.
- Pinning compares `projectConnectionId`, not site URLs. (Today `resolveSourceIssue`,
  `providers/jira/actions.ts`, only compares `source.url` with the site and skips the check without a
  URL, so a numeric id from site B could reach site A.)
- `connection:` on a typed `source_item` action is a **filter** ("only for runs whose source is
  this connection"); runs from another source skip it with a reason.
- External tools that take an item key check it against the granted connection's settings (`JB-42`
  refused on `jira-1` with `projectKeys: [JA]`) and fetch it through that connection before writing.
- Fixed `with` values are removed from the tool's input schema and enforced server-side.
- Without any grant instructions and agent steps can only read the source item. Missing
  configuration narrows rights, never widens them.

### 2.5 YAML

Workflow:
```yaml
project: billing                         # default project of every trigger
triggers:
  - connection: jira-customer            # key in project "billing"
    type: jira.issue_assigned
    config:
      projectKeys: [JA]
  - project: payments                    # this trigger's own project
    connection: jira-payments
    type: jira.issue_assigned
actions:
  - on: execute.started                 # typed source_item action: pinned, no connection
    type: jira.transition_issue
    config:
      transitionName: In Progress
  - on: execute.completed               # typed external action: the connection is the grant
    connection: teams-release
    type: microsoft_teams.post_message
  - on: execute.completed               # instruction: read-only unless granted
    instruction: >
      Comment the PR link on the ticket. Create a QA task with the test plan and
      link it in the comment.
    connections:
      source: [comment]
      jira-internal:
        allow: [jira.create_issue]
        with: { projectKey: OPS, issueType: Task }
        approval: required               # optional
```

Process agent step (`packages/api/src/types/project-process.ts`, `ProcessStepType.Agent`):
```yaml
steps:
  - type: agent
    name: Investigate
    instruction: Read the ticket and the related tickets in jira-internal, then write the analysis.
    connections:
      source: read                       # the default, may be omitted
      jira-internal: read
```
Grant forms: `<key>: read`, `<key>: [op, …]`, `<key>: { allow, with?, approval? }`. On `source`
the ops are generic (`comment`, `transition`) because the source may be Jira or Azure DevOps; on
other keys they are provider operations (`jira.create_issue`). Any write grant implies `read`.

### 2.6 Grants → MCP tools
The session descriptor (§1.6) is computed from these grants: `read` → the provider's read tools;
each allowed op → its write tool; `source: [comment, transition]` → `source_item_comment` /
`source_item_transition`. Nothing else is
registered. The editor guide (§2.9) shows the resulting tool list per action/step.

### 2.7 Items created by a run
Creating tools/actions accept `as`; `WorkflowRunCreatedItem` stores it. Later actions use
`{{created.qa_ticket}}`; operations on it are pinned to the connection that created it (rule 1
applied to created items) and need no extra grant for comment/transition on it.

### 2.8 Validation (shared module in `packages/api`, used by the API on save/run and by the editor)
- Keys exist in the workflow's project; ops offered by the provider; `with` validated by the op's
  config schema and within project settings.
- Every trigger has a project (root or own); keys used by actions/steps exist in every trigger
  project.
- Trigger `projectKeys` ⊆ the project connection's keys.
- Typed `external` action without `connection:` and several candidates → error.
- `source_item` ops in a workflow whose triggers cannot produce a source item (HTTP only) → error.
- Grant of a `source_item` op → warning (always allowed on the source).
- Instruction text mentioning a key that is not granted → warning.
- Deleting a project connection used by a workflow or the current process version → refused.

### 2.9 Editor: autocomplete and guidance
Builds on `workflow-yaml-completions.ts`, `process-yaml-completions.ts`, `shared/lib/yaml-cursor.ts`,
`WorkflowYamlIntro`, `WorkflowYamlProblems`.
- Completions: `connection:` / `connections:` → project keys with display name and provider
  (`source` first); `type:` / `allow:` → the provider's ops grouped by target; `with:` → op fields and
  allowed values (Jira `projectKey` from `projectKeys`; issue types/transitions fetched lazily);
  `approval: required`; `source` grants `read` / `comment` / `transition`; `project:` → projects; `{{` → `source.*`, `created.<name>`.
- Snippets: comment on the source item, move the source item, create a follow-up item elsewhere,
  notify a Teams channel, run an ADO pipeline, agent step reading another Jira.
- Live diagnostics while typing (debounced) from the shared validator (§2.8), not only after save.
- Hover: key → provider, display name, settings; op → description, target, whether it needs a grant.
- Guide panel (collapsible, next to the editor): "Connections in this project" (keys, provider,
  settings, copy buttons, link to Project settings for admins); "How a connection is chosen" (the
  three rules with examples); "Tools the agent gets" for the action/step under the cursor (§2.6);
  empty states when there is no project or no connection.
- `docs/workflows.md` gets the same content.

### 2.10 Scenarios

| # | Scenario | Result |
|---|---|---|
| 1 | Ticket from Jira A, "move to In Progress" | Typed action: pinned to A, no config. Instruction: needs `source: [transition]`, then `source_item_transition` on A. |
| 2 | Project has `jira-1`, `jira-2`; source `JA-7` on jira-1; title mentions `JB-42` (jira-2) | Only `JA-7` moves. Source tools have no item parameter; `jira_transition_issue` is not even registered without a grant. |
| 3 | Same, action has `connection: jira-1`, run comes from jira-2 | Action skipped: "source is jira-2, action is for jira-1". |
| 4 | Only the trigger names a connection; actions/steps name none | Typed source ops run on the source; instructions and agent steps can only read the source item; typed external actions fail validation at save. |
| 5 | Create a follow-up in jira-2, agent tries jira-1 | `jira_create_issue` connection enum is `["jira-2"]`; a forged call is refused by the API. |
| 6 | Workflow with triggers on two Jiras | Each run pinned to its own source. |
| 7 | Sub-task in the source Jira | Needs a grant on the source's project connection key: `jira-customer: [jira.create_issue]`. |
| 8 | Update the created item later | `{{created.x}}` pinned to its creating connection. |
| 9 | HTTP trigger / manual run without a source item | No `source_item_*` tools; every write needs a grant. |
| 10 | Notify the Teams release channel, not dev | `teams_post_message` enum `["teams-release"]`. |
| 11 | Prompt injection in ticket text | Limited to granted tools; ticket text marked untrusted; refusals logged on the run page. |
| 12 | Personal-account project connection | Pinned like any other; UI warns; admin may grant comment only. |
| 13 | Connection deleted / in error mid-run | Calls fail with a clear reason; no fallback to another connection. |
| 14 | Agent repeats a write after a timeout | Idempotency key returns the first result. |
| 15 | Write that needs a human | `approval: required` → pending on the run page. |
| 16 | Agent with Bash reads the session token | Same rights as its tools; expires with the step. |
| 17 | Admin binds Jira key `JA` to a second project connection (any project, any account) | Refused: scope `jira:<site>:JA` already owned by `jira-customer` in `billing`. |
| 18 | Workflow with triggers in `billing` and `payments`, action uses `teams-release` | Valid only if both projects have a `teams-release` connection; otherwise a save error naming the project. |

---

## Rollout

1. Foundation: schema + migration (clean slate) + admin API/UI + conflict checks + effective
   runtime + polling per account.
2. Part 2 for triggers and typed actions: references by key, validation, editor, pinning fix.
3. Part 1: session tokens, `/integration-tools/*`, `ist_` sessions in `apps/mcp`, generic source
   tools + Jira tools, runner MCP wiring; instructions cut over from operations JSON to tools.
4. Agent-step grants in processes + loop wiring; Azure DevOps, Teams and webhook tools.
5. Approval for grants; created items across actions.

## Tests

- DB: migrations (unique/FKs/`Restrict`, scope uniqueness), data cleanup, seed.
- Foundation: conflict refusals (scope owned elsewhere, same connection twice in a project),
  routing through `ProjectConnectionScope`, admin-only routes, key format/conflict/immutability, override validation incl.
  gateway fallback, origin change → `error`, DTOs carry hints only, polling per account.
- Session tokens: minted only for the runner the run is dispatched to; refused after the action
  run / loop ends; refused outside `/integration-tools/*`; user API keys get no integration tools.
- Tool descriptors: per-session filtering from grants, key enums, fixed values removed; description
  rules test over every tool (sections present, length caps, no secrets).
- Tool calls: every §2.10 scenario as a test (2-Jira title injection, filter skip, forged
  connection, project-key check, idempotent repeat, approval pending, created-item pinning) for Jira
  and Azure DevOps; Teams with two channels; webhook.
- Runner: MCP config with env-referenced token, strict config for instructions, allowed tools,
  version gate.
- Editor: completions per cursor position, live diagnostics equal to the API validator, hover, the
  guide's tool list per action/step.
- Tool-choice evals (non-blocking CI job): scripted instructions ("move this ticket to Done",
  "create a QA task in OPS", the 2-Jira case) against the real tool descriptors; assert the chosen
  tool and arguments.

## Resolved questions (2026-10-13)

1. Workflow project: root `project:` or per trigger; required.
2. Existing data: no backfill; workflows and project repositories are deleted by the migration.
3. Interactive sessions: none — agents run only in runners; headless runners are isolated; the
   desktop app is out of scope for now.
4. Conflicts: refused, org-wide (`ProjectConnectionScope`).
5. Agents are read-only by default; writes are listed in the workflow/process grants.
