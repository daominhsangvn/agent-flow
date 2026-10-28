# Workflow orchestrator

Each orchestrated workflow has its own **orchestrator**: an agent, on a runner
of its own, that every request of the workflow goes to. It reads the request
(a mention or a reply on a ticket, a message in a Teams thread, a task that
finished), the workflow's rules and what each runner declares it can do, then
chooses which command of which runner does the work, and answers.

```
Jira / Teams / ... ──trigger of an orchestrated workflow──► orchestrator (its runner)
                                                              │ reads: the thread, the ticket, the case,
                                                              │        the workflow's rules, AGENTFLOW.md of each runner
                                                              ├─► command on runner BA  ─┐
                                                              ├─► command on runner QC  ─┤ results come back,
                                                              │                          │ the orchestrator wakes up
                                                              └─◄────────────────────────┘ and answers in the thread
```

Status: phases 1-6 of the plan are built: runner capabilities, the
orchestrator settings, `agent.mode: orchestrated`, taking requests
(conversations, turns, replies), tasks on other runners with wait conditions,
`supersede`, Teams thread replies, decisions and edited messages, and the case
pages. Auto runners' capabilities from the toolkit (phase 7) and the guards
(phase 8) come next. The orchestrator configuration moved from the project into
the workflow.

## Settings (the orchestrated workflow)

Set in the workflow (editor or YAML) with `agent.mode: orchestrated`.

| Setting | Meaning |
|---|---|
| `enabled` (workflow) | The orchestrator takes the workflow's requests. Needs a runner. |
| `agent.runner` | The computer its turns run on (Claude Code with the orchestrator's tools only). A computer the admin owns or one shared with the organization. |
| `agent.instructions` | The rules (up to 8000 characters): which runner handles what, the order of the work, what needs an admin's approval. Sent with every turn. |
| `agent.orchestrator.concurrency` | `supersede` (default): a new message on a thread whose turn is running stops that turn, and the next turn answers both. `queue`: the running turn finishes, the next one takes every new message. Messages on different threads always run in parallel. |
| `agent.orchestrator.debounceSeconds` | Seconds a thread stays quiet before a turn starts, so a burst of messages is one turn (default 20). |
| `agent.orchestrator.turnTimeoutMinutes` | Minutes one turn may take (default 10). |
| `agent.orchestrator.cancelOn` | Ticket-change kinds whose turn may cancel tasks with `task_cancel`: `status_changed`, `label_added`, `label_removed`. Default `[status_changed, label_removed]`; `[]` = the orchestrator never cancels. |

```yaml
agent:
  runner: runner-orch
  mode: orchestrated
  instructions: |
    BA answers requirements questions; Dev implements; QC tests. Ask an admin
    before anything that changes a release.
  orchestrator:
    concurrency: supersede
    debounceSeconds: 20
    turnTimeoutMinutes: 10
    cancelOn: [status_changed, label_removed]
```

**Deployment model.** The orchestrator runs on one headless runner with no
repository clone: its turns run in an empty folder with the MCP tools only.
BA, Dev and QC run on personal runners, whose AGENTFLOW.md comes from their
project folder.

## Orchestrated workflows

A workflow with `agent.mode: orchestrated` keeps its triggers and starts no run:
each request goes to the workflow's own orchestrator. Saving one refuses
`agent.process` and `agent.runners` (`workflow-validation.ts`
`checkOrchestrated`); ingest never creates a run for it (`engine/ingest.ts`
`isOrchestratedTrigger`). Several workflows may take the same event, each with
its own cases. The workflow's `description` tells the orchestrator what the
workflow is for.

```yaml
name: Questions on LeaveDesk tickets
description: People mention the bot on a ticket to ask about requirements or the project.
project: LeaveDesk
triggers:
  - connection: jira
    type: jira.issue_mentioned
agent:
  runner: runner-orch
  mode: orchestrated
  instructions: Rules for the orchestrator.
  orchestrator:
    concurrency: supersede
```

## How a request is taken

**Cases and conversations** (`apps/api/lib/orchestrator/inbound.ts`,
`channel.ts`). Ingest offers every event to the orchestrator
(`engine/ingest.ts` `routeOrchestrated`). It takes one when a trigger of an
orchestrated workflow matched it, or when it replies to a message the
orchestrator posted (an **anchor**), whatever the triggers. No model is
asked where it belongs:

| The event | Its conversation (`channelKey`) |
|---|---|
| A reply to an anchor | the anchor's conversation |
| A Teams message (post or reply) | the Teams thread: `microsoft_teams:<thread key>` |
| A Jira comment replying to another comment | that comment thread: `jira:<KEY>:comment:<parent id>` |
| A Jira mention on the issue | the issue's top level: `jira:<KEY>:item` |
| A Jira status or label change (`jira.issue_status_changed`, `jira.issue_labeled`) | the issue's top level: `jira:<KEY>:item` |

A ticket change (`InboundEvent.itemChange`, turned into a message by
`ticket-change.ts`) is stored as an external message of kind `status_changed`
(text `Status changed: A → B (by X)`, payload `{from, to, actor}`), `label_added`
(`Label added: x (by X)`) or `label_removed` (`Label removed: x (by X)`);
the label payload is `{added, removed, actor}`.

A conversation belongs to the **case** of its source item (`jira:LD-7`: one
case per item per workflow: unique on `workflowId, sourceKey`; conversations are unique per case and channel). The event's comment or message (`InboundEvent.
message`, filled by the Jira and Teams providers) is stored once as an
**external message** (`message:<comment id>`: the reply and mention events of
one comment are one message). The conversation's `nextWakeAt` moves to now +
the workflow's quiet time, so a burst of messages is one turn.

**Turns** (`apps/api/lib/orchestrator/advance.ts`). The workflow tick
(every `WORKFLOW_TICK_SECONDS`) advances the conversations whose `nextWakeAt`
passed and those with a running turn; each conversation is leased while it
moves, so it has one turn at a time, and different conversations run in
parallel. A turn takes every message no turn took, renders the prompt
(`turn-prompt.ts`: the role, "Your rules" from the workflow, the thread, CASE.md from
`case-render.ts`, the runners' commands, the new messages marked untrusted)
and sends it to the orchestrator's runner as the desktop command
`orchestrator_turn` (`dispatchOrchestratorTurn`). The runner
(`apps/desktop/src/server/operations/orchestrator-turn.ts`) runs Claude Code
in `<workspace>/.agentflow-ai/orchestrator/<workflow id>` with
`--resume <session>` when the conversation has one (a session this computer
does not have starts over: CASE.md carries what matters), only the
orchestrator's tools allowed (`mcp__agentflow_orchestrator`) and files,
shell and web denied. The result line carries the note, the session id and
the usage.

Settling a turn: the session is kept for the next turn of the conversation,
and the conversation waits (`waiting`), or is closed when the turn closed the
case. A turn whose tools declared nothing waits for people. A failed turn
gives its messages back to a turn two minutes later, at most three failed
turns in a row; a turn that cannot be sent fails the same way. While a turn
runs, newer messages wait for the next one (`queue`), or stop it
(`supersede`, below). A disabled workflow (or one without a runner)
keeps its messages and looks again every five minutes.

**Supersede.** With `concurrency: supersede`, a newer external message on a
conversation whose turn runs, once its thread is quiet, stops that turn:
the API sends the runner `orchestrator_turn_cancel` (once per turn; the
request is kept in the turn's `usage`), the runner kills the turn's process
and its command answers `ORCHESTRATOR_TURN_STOPPED_ERROR`. The turn settles
as `superseded`, its input messages (not its replies) go back to the next
turn with the new one, and that turn resumes the stopped turn's session. A
turn that finished before the stop arrived settles as usual.

In a `supersede` conversation, from the moment a newer external message
waits (or a stop was requested for the turn), the running turn's write
tools (`reply`, `edit_reply`, `task_run`, `task_cancel`, `request_decision`,
`record_decision`, `close_case`) are refused with `superseded: a newer message
arrived; end the turn`. Reads, `case_update_notes`, `wait_for` and `wait_human`
stay allowed (`lib/orchestrator/supersede.ts`).

**Threads without a mention.** An event no trigger matched and that replies
to no anchor still reaches the orchestrator when its channel already has a
conversation (`orchestrator_conversations.channelKey` on the same workflow
connection): a Teams reply in a thread the orchestrator talks in arrives as
`microsoft_teams.thread_reply` (Teams sends the bot every channel message
with ChannelMessage.Read.Group; a new post without a mention is still
ignored), a Jira reply in a comment thread it talks in as
`jira.comment_reply`.

**Tools** (`apps/api/app/orchestrator-tools/service.ts`). The runner
exchanges the turn for an `ost_…` token (`POST /desktop/orchestrator-sessions`,
the computer the turn was sent to, its owner's API key); apps/mcp serves the
tools for that token from `GET /orchestrator-tools/session` and
`POST /orchestrator-tools/call`. The token works while the turn runs.

| Tool | Does |
|---|---|
| `case_get` | CASE.md: notes, conversations with their latest messages, tasks, decisions |
| `case_update_notes` | Replaces the case's notes |
| `runners_list` | Each runner's AGENTFLOW.md (commands, skills, online) |
| `source_item_get` | The conversation's item through its project connection |
| `reply` | Posts in the conversation's thread through the provider's `replyOnItem` (Jira: a comment in the thread of the comment answered, on the issue when the site refuses threads; Teams: a reply in the thread mentioning who asked last). Kept as a `reply` message and an anchor |
| `task_run` | Starts a runner's command as a task (below); optional `replyTo`: the message ref the task answers |
| `task_get` | A task's status, answer, questions and error, and the message it answers (`replyTo`) |
| `task_cancel` | Cancels a task of the case with a reason ("Cancelling tasks" below); only in a turn that took a ticket change listed in `cancelOn` |
| `wait_for` | Ends the turn waiting for tasks: `all` (default) or `any`, `timeoutMinutes`, `wakeOnFailure` (default true) |
| `request_decision` | Asks people to approve or reject: a decision row, and the question posted in the thread with the case's link |
| `record_decision` | Records a decision someone gave in the thread (`via: message`) |
| `edit_reply` | Replaces the text of a message this conversation posted (provider `editOnItem`: Jira `PUT comment/{id}`, Teams activity update); `version` moves the anchor's version |
| `wait_human` | Ends the turn waiting for people |
| `close_case` | Ends the turn and closes the case (a new message reopens it) |

## Tasks and waits

**A task** (`apps/api/lib/orchestrator/tasks.ts`) is one command of one
runner, run as a STEP loop on that runner. `task_run` takes the runner (its
name, the role its AGENTFLOW.md gives it, or its id), the command, its args
and a prompt (the request and the context the runner needs: it sees only
that and the case); the mode is the command's declared one unless given.
The loop:

- works on **the case's Issue on that runner**: an Issue document made with
  the case's first task there (`orchestrator_tasks.documentId`, titled
  `<case> · <runner>`, CASE.md as its body). It carries the project, its
  repositories (cloned like any loop's) and the project key a personal
  runner checks, and names the runner's workspace for the case, so the
  case's tasks on a runner share one workspace (`fresh` only for the first)
  and a later task resumes an earlier one's session (`resumeTaskId`: its
  loop becomes the parent; `fork: true` resumes in a copy, e.g. to ask about
  a plan without changing its session). One loop runs on an Issue at a time:
  a second task of the case on the same runner waits (`queued`).
- has step settings (`LoopStepConfig`): `runId` = the case (a personal
  runner keeps one work directory per case), `stepId` = the task,
  `askQuestions` from the command's `asks`, the answer file collected
  (`ORCHESTRATOR_TASK_REPLY_FILE`, `.agentflow-ai/work/orchestrator-reply.md`;
  `$AGENTFLOW_WORKDIR/orchestrator-reply.md` on a personal runner), `push`
  from the command's `push` on an auto runner (a personal runner's command
  pushes itself), and `readOnly` for a read: Edit, MultiEdit, NotebookEdit,
  `git commit` and `git push` are denied (`READ_ONLY_STEP_DISALLOWED_TOOLS`,
  the answer file is still written), `attach` from the command's `attach`
  globs, and `inputs` from `task_run files` (written to `inputs/` before the
  agent starts).
- runs as the runner's owner. When the runner is offline the task fails with
  "Runner X is offline: the task was not started..."; when it is busy the task
  stays `queued` and `task_run`, `task_get`, wait results, CASE.md and the case
  page show it as `waiting` with the reason. A queued task that fails on a later
  tick wakes the wait. A personal runner that runs one task at a time
  takes them in turn: the task stays `queued` and the tick tries again.

**Guards.** `task_run` (through `startTask`) refuses a task before it is
created when:

- **declared**: the command is not in the runner's AGENTFLOW.md (a file that
  does not parse refuses every command). A queued task is checked again when
  it launches and fails if its command is no longer declared.
- **mode**: it asks for `mode: write` on a command declared `mode: read`.
  `mode: read` on a write command is allowed (a read-only step, no push).
- **push**: not a refusal. AgentFlow pushes only for an auto runner's command
  with `push: true` run in write mode; a read command that declares `push`
  gets a capabilities warning.
- **needs**: a `needs` tag has producers (commands of the project whose
  `produces` is that tag) with `attach` globs, and neither the passed `files`
  nor the ticket's attachments match one of them by file name. A need with no
  producer or no `attach` is not checked, and the check passes when the ticket
  cannot be read (fail-open). The runner-side BLOCKED check stays. Tasks with
  `resumeTaskId` are exempt.

Every refused tool call (`ok: false`, not retryable) is recorded as a
`tool_refused` message on the conversation (`<tool> refused: <error>`, no tool
input). It never wakes a turn, shows as "Refused" in the case detail and
appears in CASE.md's recent messages.

**Files.** A command declares `attach` globs in AGENTFLOW.md (relative to the
task's work directory). `buildStep` adds them to the step's `attach`, and the
runner collects the matches as bytes when the loop ends (at most 20 files,
4 MB each, 5 MB together; files over a limit are reported as skipped or
omitted). The upload route stores them in the loop-state bucket under the
loop's prefix (deleted with it 90 days after completion). The task result
lists them (name, size) in `task_get`, wait results and CASE.md.

- `reply attachments: [{taskId, name}]` uploads files of tasks of the same case
  to the source item through the source's `attachFile` (Jira; Teams refuses),
  one after another, then posts the comment with the files shown. A failure
  posts nothing and names what was already attached. `edit_reply` takes no
  attachments.
- `task_run files: [{taskId, name}]` passes text files of earlier tasks (at
  most 5, 200 KB each, 400 KB together) to the new task. They are written to
  `inputs/` in its work directory and kept in the task result until launch.
- `task_run replyTo` is checked against the conversation's messages, stored in
  the task result, and shown in `task_get`, wait results and CASE.md ("answers
  ref ...").

The case pages are on Workflow → Cases, with a breadcrumb back to the workflow.

The tick (`advanceDueConversations`) launches queued tasks, settles running
ones whose loop ended (`isLoopSettled`: a revivable timed-out loop is still
running): `succeeded` with the answer file and the questions, `failed` with
the loop's error. The task's result keeps its `inputs`, `replyTo` and
cancel/waiting notes when it settles or fails.

**Waits** (`waits.ts`). `wait_for` stores what the conversation waits for and
ends the turn. The engine evaluates it in code whenever one of its tasks
settles, and its deadline from the tick: while the condition does not hold
nothing happens (no turn, no model call); once it does (or a task failed,
with `wakeOnFailure`, or the deadline passed) the wait fires once, an
internal message (`task_results`, `deadline`) carries each task's status,
answer, questions and error, and the conversation's next turn is due at once.
Tasks that already finished fire the wait as soon as it is stored. Waits of
one conversation that fire in the same evaluation (or the same deadline tick)
post one combined message, with each task listed once.

**Cancelling tasks** (`task-cancel.ts`). `task_cancel { taskId, reason }` is
accepted only in a turn that took a message whose kind is in `cancelOn`
(default `status_changed` and `label_removed`; `[]` = never); otherwise the
refusal names the setting. Comments, questions and replies never allow it. Any
task of the same case can be cancelled, never another ticket's case.

- running: the loop is stopped through `engine/cancel.ts` `cancelLoop`.
- queued: never dispatched.
- finished: closed, so it cannot be resumed.

Waits count `cancelled` as finished and wake at once with
"cancelled: <reason>", including a comment-thread turn waiting in parallel.
CASE.md "started for" names the status, label or message that started each
task, so only the removed label's tasks get cancelled. The turn prompt has a
"Ticket changes" section; debounce merges a burst of flips into one turn that
sees the sequence and the final status.

## Decisions

`request_decision` stores a pending decision on the case and posts its
question. It is decided once (`lib/orchestrator/decisions.ts`), either way:

- **in AgentFlow**: `POST /orchestrator/decisions/{id}` (`{ approved,
  comment }`, org admins only) records it in the admin's name (`via:
  button`), and an internal `decision` message wakes the conversation;
- **in the thread**: the orchestrator records what someone said with
  `record_decision` (`via: message`, who as written); it already knows, so
  no message wakes it again. Who may decide this way is one of the guards
  (phase 8).

## What runners can do (AGENTFLOW.md)

The orchestrator chooses among the commands the runners declare in their
`AGENTFLOW.md`: docs/runner.md "Capabilities (AGENTFLOW.md)". Project →
Integrations → Commands shows them.
