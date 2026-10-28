import {
  ORCHESTRATOR_DEBOUNCE_SECONDS_DEFAULT,
  ORCHESTRATOR_DEBOUNCE_SECONDS_MAX,
  ORCHESTRATOR_TURN_TIMEOUT_MINUTES_DEFAULT,
  ORCHESTRATOR_TURN_TIMEOUT_MINUTES_MAX,
} from "@repo/api/src/types/orchestrator";
import {
  WORKFLOW_ACTIONS_MAX,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_INSTRUCTIONS_MAX,
  WORKFLOW_TRIGGERS_MAX,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WORKFLOW_RUNNER_CONDITION_FIELDS } from "@repo/api/src/types/workflow-runner-rules";
import { CONNECTIONS_GRANT_DOC } from "@repo/app/integrations/lib/connection-grant-completions";
import {
  BUILT_IN_HTTP_REFERENCE,
  BUILT_IN_HTTPS_CALL_TYPE,
} from "./workflow-yaml-schema";

/**
 * What the workflow YAML means, written once for the editor's suggestions
 * (workflow-yaml-completions.ts) and its configuration guide
 * (components/workflow-configuration-guide.tsx): the keys, how an action's
 * instruction runs, which connection an action without one works on, and
 * worked examples.
 */

export type WorkflowYamlKeyDoc = { detail?: string; info: string };

export const WORKFLOW_YAML_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> = {
  name: { detail: "text, required", info: "How the workflow is listed." },
  description: { detail: "text", info: "What the workflow is for." },
  enabled: {
    detail: "true (default) | false",
    info: "Triggers start runs only while the workflow is enabled.",
  },
  triggers: {
    detail: `list, 1-${WORKFLOW_TRIGGERS_MAX}`,
    info: "Events that start a run. A run imports the item as a PRD or an Issue and hands it to the agent team. An event that matches a run waiting for answers resumes that run instead of starting one.",
  },
  actions: {
    detail: `list, up to ${WORKFLOW_ACTIONS_MAX}`,
    info: "Run in order on the run events each lists (on:). An action is an instruction an agent carries out, or a type with its config. Left out: the run changes nothing outside AgentFlow.",
  },
  on: {
    detail: "run event | [run events]",
    info: `When the action runs. ${WorkflowRunEvent.Triggered} runs before the agent team (a failure stops the run unless continueOnError is true); the others after, in list order.`,
  },
  instruction: {
    detail: "text with {{variables}}",
    info: "What an agent does on the run's source item, e.g. Move the issue to In Progress. It reads the run's plan folder (PRD, plan, execution result, repositories) and only reads unless connections: grants writes; AgentFlow carries out what it proposes.",
  },
  connections: CONNECTIONS_GRANT_DOC,
  preActions: {
    detail: "list (older form)",
    info: `The older form of actions with on: ${WorkflowRunEvent.Triggered}.`,
  },
  agent: {
    detail: "mapping",
    info: "How the agent team works on each item: runner (required), run-as user, mode, PRD rule, title, extra instructions, process.",
  },
  postActions: {
    detail: "list (older form)",
    info: "The older form of actions on later run events (events:).",
  },
  connection: {
    detail: `${BUILT_IN_HTTP_REFERENCE} | connection key`,
    info: `The key of a project connection (Project → Integrations), or ${BUILT_IN_HTTP_REFERENCE}: the workflow's own URL (trigger) or a plain HTTPS call (action). A typed action may leave it out: the run then chooses (see the configuration guide).`,
  },
  type: {
    detail: "trigger or action type",
    info: "One of the types the connection's provider offers, e.g. jira.issue_assigned.",
  },
  config: {
    detail: "mapping",
    info: "The type's options; Ctrl+Space lists them.",
  },
  continueOnError: {
    detail: "true | false",
    info: `Go on to the agent team when this ${WorkflowRunEvent.Triggered} action fails.`,
  },
  events: {
    detail: "list of run events",
    info: `When the post action runs (older form of on:), e.g. [${WorkflowRunEvent.PlanReady}, ${WorkflowRunEvent.Failed}].`,
  },
  project: {
    detail: "project name or id, required",
    info: "The project the runs belong to: imported Issues and plans are created in it and connection keys are its. A trigger may name its own project.",
  },
  runAs: {
    detail: "user email",
    info: "Commit author and concurrency budget of the loops. Left out: whoever saves a new workflow, the stored user on an existing one.",
  },
  runner: {
    detail: "runner name or id, required",
    info: "The runner the loops run on (owned by the run-as user or shared with the organization). A project with runners of its own uses those. With runners: rules, the runner when no rule matches. Orchestrated: the orchestrator's runner, a headless runner; its turns need no repository.",
  },
  runners: {
    detail: "list of runner + condition, optional",
    info: 'Runner rules: when a run imports its item, the first rule whose condition holds runs it on that rule\'s runner, e.g. the personal runner of the assignee (condition: source.assignee_email == "an@acme.dev"). None matching: runner. Decided once per run.',
  },
  mode: {
    detail: "plan | plan_and_execute (default) | orchestrated",
    info: "Plan only, or plan and implement (the changes are pushed; a create pull request action opens the pull request). A process replaces it: its steps say what runs. orchestrated starts no run: each request goes to this workflow's orchestrator on agent.runner, which follows agent.instructions; the workflow has no process and no runners. Ticket changes (a status, a label added or removed) reach it as status_changed / label_added / label_removed messages.",
  },
  stopOnOpenQuestions: {
    detail: "true (default) | false",
    info: "Plan and implement without a process: wait for a person (input.needed) when the plan has open questions; false implements the plan as it is. A process step's questions: replaces it.",
  },
  repository: {
    detail: "mapping",
    info: "A repository of the project's team pool to use instead of the project's repositories. Left out: every repository of the project.",
  },
  fullName: { detail: "owner/name", info: "The repository, e.g. acme/web." },
  branch: { detail: "branch", info: "The branch the work is based on." },
  prd: {
    detail: "mapping",
    info: "Which items are imported as a PRD instead of an Issue, decided by the run's computer from instruction. Left out: every item is an Issue.",
  },
  titleTemplate: {
    detail: "text with {{variables}}",
    info: `Title of the imported PRD or Issue. Default: ${WORKFLOW_DEFAULT_TITLE_TEMPLATE}.`,
  },
  instructions: {
    detail: `text, up to ${WORKFLOW_INSTRUCTIONS_MAX} characters`,
    info: 'Appended to every imported PRD or Issue under "Additional instructions". Orchestrated: the orchestrator\'s rules, sent with every turn.',
  },
  orchestrator: {
    detail: "mapping, orchestrated mode",
    info: "How the orchestrator takes a thread's messages: concurrency, debounceSeconds, turnTimeoutMinutes and cancelOn. Left out: the defaults.",
  },
  process: {
    detail: "mapping",
    info: "The workflow's own process (the agent team's steps), written like a project's Process tab (see the Process tab of this guide). Left out: the project's process; a project without one runs mode.",
  },
};

/** The keys of an `actions` item, where they differ from the others. */
export const WORKFLOW_ACTION_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> = {
  on: WORKFLOW_YAML_KEY_DOCS.on as WorkflowYamlKeyDoc,
  instruction: WORKFLOW_YAML_KEY_DOCS.instruction as WorkflowYamlKeyDoc,
  type: {
    detail: "action type",
    info: "Instead of an instruction: an action type, e.g. jira.add_comment, local_git.create_pull_request, or agentflow.email (sent by AgentFlow through the server's mail relay; config: to, cc, subject, body). The connection's types are suggested; without a connection, every connection's.",
  },
  config: {
    detail: "mapping",
    info: "The type's options (an instruction has none). Left-out options take their defaults; {{variables}} work in text options.",
  },
  connection: {
    detail: `connection key | ${BUILT_IN_HTTP_REFERENCE} | left out`,
    info: `Where a typed action acts: a project connection key, or ${BUILT_IN_HTTP_REFERENCE} for the workflow's own HTTPS call (type ${BUILT_IN_HTTPS_CALL_TYPE}). An action on the source item with a key runs only for runs from that connection. Left out, the run chooses: see "How a connection is chosen". An instruction takes connections: instead.`,
  },
  connections: WORKFLOW_YAML_KEY_DOCS.connections as WorkflowYamlKeyDoc,
  continueOnError: {
    detail: "true | false",
    info: `Only for ${WorkflowRunEvent.Triggered}: go on to the agent team when this action fails (default false: the run fails).`,
  },
  enabled: {
    detail: "true | false",
    info: "false keeps the action in the YAML but never runs it.",
  },
};

/** How an instruction runs, for the configuration guide. */
export const WORKFLOW_INSTRUCTION_GUIDE: readonly string[] = [
  "An agent on the run's runner reads the run's plan folder: the PRD (prd.md), the plan (plan.md, plan.json), what EXECUTE did (execution-result.json) and the repositories with their git history. What exists depends on the event: nothing but the request at workflow.triggered, the plan from plan.completed, the changes from execute.completed.",
  "It works through the AgentFlow integration tools (an MCP server) and gets only the tools connections: grants: source_item_get always, source_item_comment / source_item_transition for source: [comment, transition] (pinned to the run's source item), connection_get_item for a granted key (only items in that connection's projects), one tool per operation granted on another key. AgentFlow checks every call and carries it out with the grant's fixed options (with:); at most 5 writes per run of the instruction. Credentials never reach the runner.",
  "approval: required on a grant keeps its tools, but each write waits on the run page (Integration tool calls) until an org admin approves or rejects it. Process agent steps get tools the same way from their own connections:.",
  'Write what to do in plain words, e.g. Move the issue to "In Progress" or Summarize what was implemented and comment on the issue. {{variables}} are filled in first.',
  "Each run of an instruction is a short Claude Code session (about 20-60 s); its note, tool calls, tokens and cost are on the run page under Actions.",
  "Once a write succeeded the instruction is not retried, so nothing is posted twice; an agent that failed, or whose write failed before any succeeded, is retried after 30 s, 2, 10 and 30 minutes.",
];

/** Which connection an action without one works on. */
export const WORKFLOW_CONNECTION_CHOICE_GUIDE: readonly string[] = [
  "Pinned to the source: a comment or a transition always works on the item that started the run, through the connection whose trigger started it (the Jira of the ticket). An item key written in the ticket can never send it elsewhere; with connection: it runs only for runs from that connection.",
  "Granted, never guessed: an instruction's agent reads the source item and only has tools for what connections: lists. Any other connection or operation is refused and recorded.",
  "A repository action (Create pull request): every connection that holds one of the run's repositories, so each repository the agent team pushed gets its pull request.",
  "Any other type without connection: the project's only connection that offers it; with several, name one. Saving checks this; a run where none fits skips the action and says why.",
];

/** The order actions run in. */
export const WORKFLOW_ACTION_ORDER_GUIDE =
  "Actions run one at a time in the order of the list, also when one step reports several events: put the pull request before an instruction that should link it ({{pr.url}}). An action still waiting (its retry or its agent) holds the ones after it.";

export type WorkflowActionExample = {
  title: string;
  description: string;
  yaml: string;
};

/** Worked `actions` lists, for the configuration guide. */
export const WORKFLOW_ACTION_EXAMPLES: readonly WorkflowActionExample[] = [
  {
    title: "Ticket status and a summary",
    description:
      "A Jira (or Azure DevOps) trigger: the ticket moves to In Progress before the agent team, the pull request is opened, then a summary of the work is commented on the ticket.",
    yaml: `actions:
  - on: ${WorkflowRunEvent.Triggered}
    type: jira.transition_issue
    config:
      transitionName: In Progress
  - on: ${WorkflowRunEvent.Succeeded}
    type: local_git.create_pull_request
  - on: ${WorkflowRunEvent.ExecuteCompleted}
    instruction: |
      Summarize what was implemented for {{source.key}}: the files that
      changed, the tests, and the pull request ({{pr.url}}). Post it as one
      comment on the issue.
    connections:
      source: [comment]
`,
  },
  {
    title: "Ask for answers on the ticket",
    description:
      "When the plan has open questions, the agent writes them as one comment; a fixed comment with the ready-made summary works too.",
    yaml: `actions:
  - on: ${WorkflowRunEvent.NeedsInput}
    instruction: |
      List the open questions of the plan (.agentflow-ai/work/plan.md) as one
      comment on the issue and ask the reporter to answer them there.
    connections:
      source: [comment]
  - on: ${WorkflowRunEvent.PlanReady}
    type: jira.add_comment
    config:
      message: "{{summary}}"
`,
  },
  {
    title: "Tell a channel when a run fails",
    description:
      "A Microsoft Teams project connection named by its key: the failure summary is posted there.",
    yaml: `actions:
  - on: ${WorkflowRunEvent.Failed}
    connection: teams-release
    type: microsoft_teams.post_message
    config:
      message: "{{source.key}} failed: {{error.message}}"
`,
  },
  {
    title: "Two Jiras in one project",
    description:
      "Triggers on jira-customer and jira-internal: each run moves and comments only the ticket that started it, through the connection it came from. The action keyed jira-customer runs only for jira-customer's tickets.",
    yaml: `actions:
  - on: ${WorkflowRunEvent.Triggered}
    type: jira.transition_issue
    config:
      transitionName: In Progress
  - on: ${WorkflowRunEvent.ExecuteCompleted}
    connection: jira-customer
    type: jira.add_comment
    config:
      message: "Thanks, this is ready for review: {{pr.url}}"
  - on: ${WorkflowRunEvent.ExecuteCompleted}
    instruction: Summarize the change as one comment on the ticket.
    connections:
      source: [comment]
`,
  },
  {
    title: "Send every run event to an HTTPS endpoint",
    description:
      "The built-in http connection: one action on a list of events posts each event (run, source item, plan, pull request, error) as JSON, e.g. to a team dashboard or a chat bot.",
    yaml: `actions:
  - on: [${WorkflowRunEvent.Started}, ${WorkflowRunEvent.PlanReady}, ${WorkflowRunEvent.NeedsInput}, ${WorkflowRunEvent.ExecuteCompleted}, ${WorkflowRunEvent.Succeeded}, ${WorkflowRunEvent.Failed}]
    connection: ${BUILT_IN_HTTP_REFERENCE}
    type: ${BUILT_IN_HTTPS_CALL_TYPE}
    config:
      url: https://hooks.example.com/agentflow
`,
  },
  {
    title: "Post what a process step wrote",
    description:
      "A process agent step with id release-notes and reply: writes a file; once the run succeeded its content is commented on the ticket with the pull request. On failure the ticket goes back to To Do.",
    yaml: `actions:
  - on: ${WorkflowRunEvent.Succeeded}
    type: jira.add_comment
    config:
      message: |-
        Release notes for {{source.key}}

        {{steps.release-notes.reply}}

        Pull request: {{pr.url}}
  - on: ${WorkflowRunEvent.Failed}
    type: jira.add_comment
    config:
      message: "{{summary}}"
  - on: ${WorkflowRunEvent.Failed}
    type: jira.transition_issue
    config:
      transitionName: To Do
`,
  },
];

/** The keys of `agent.prd`. */
export const WORKFLOW_RUNNER_RULE_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> =
  {
    runner: {
      detail: "runner name or id, required",
      info: "The runner of the runs this rule matches (owned by the run-as user or shared with the organization).",
    },
    condition: {
      detail: "condition on the source item, required",
      info: `When the rule applies: a field (${WORKFLOW_RUNNER_CONDITION_FIELDS.map((entry) => entry.field).join(", ")}) compared with a quoted value by ==, !=, contains or in [..], combined with &&, ||, ! and parentheses; case is ignored.`,
    },
  };

export const WORKFLOW_PRD_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> = {
  instruction: {
    detail: "text",
    info: "When an item is a PRD, in plain language, e.g. PRD when the type is Feature or User Story and it has the label PRD. The run's computer reads it with the item's type, labels, status, priority, title and description, once per run; anything it does not call a PRD is an Issue.",
  },
};

/** The keys of a `triggers` item, where they differ from the others. */
export const WORKFLOW_TRIGGER_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> = {
  project: {
    detail: "project name or id",
    info: "The trigger's own project, when it differs from the workflow's: its connection key is looked up there and its runs belong to it.",
  },
  connection: {
    detail: `connection key | ${BUILT_IN_HTTP_REFERENCE}`,
    info: `The project connection whose events start runs (Project → Integrations), or ${BUILT_IN_HTTP_REFERENCE}: the workflow's own signed HTTPS URL.`,
  },
  type: {
    detail: "trigger type",
    info: "One of the trigger types the connection's provider offers, e.g. jira.issue_conditions (the Connections tab lists them).",
  },
  enabled: {
    detail: "true (default) | false",
    info: "false keeps the trigger in the YAML but starts no run from it.",
  },
  config: {
    detail: "mapping",
    info: "The trigger type's filters, e.g. projectKeys, labels, issue types, from / to statuses, change of a label; left-out options take their defaults.",
  },
};

/** The keys of `agent.repository`. */
export const WORKFLOW_REPOSITORY_KEY_DOCS: Record<string, WorkflowYamlKeyDoc> =
  {
    fullName: WORKFLOW_YAML_KEY_DOCS.fullName as WorkflowYamlKeyDoc,
    branch: WORKFLOW_YAML_KEY_DOCS.branch as WorkflowYamlKeyDoc,
  };

/** What happens to a run from its trigger to its last action, for the guide. */
export const WORKFLOW_RUN_GUIDE: readonly string[] = [
  "A trigger matches an event of its connection (Jira assigned to the bot, a mention, a signed HTTPS request, ...) and starts a run in the workflow's project. Events the bot account caused itself are ignored.",
  "The run imports the item as an Issue, or as a PRD when the runner, reading agent.prd.instruction, decides it is one, and the implementation plan document when the run plans. Then workflow.triggered runs its actions, in order, before the agent team.",
  "The agent team runs the process: the workflow's agent.process, else the project's process, else mode (plan, or plan and implement). Every phase reports run events, and the actions listed on an event run then.",
  "A run that waits for answers (input.needed) resumes when its trigger matches again (e.g. a reply that mentions the bot): a new cycle, workflow.triggered runs again, and the plan is revised with the answers. An approval waits for an org admin on the run page.",
  "The run ends with workflow.completed or workflow.failed (also when an approval is rejected). Cancelling a run on the run page ends it without an event, so no action runs.",
];

/** How a process runs, for the guide's Process tab. */
export const WORKFLOW_PROCESS_GUIDE: readonly string[] = [
  "The steps run in order, one at a time; {{step.name}} is the one the run is in. A workflow without agent.process uses the project's process (Project → Process), written the same way.",
  `agentflow.plan: the AgentFlow planning agents write the run's implementation plan (${WorkflowRunEvent.PlanStarted}, ${WorkflowRunEvent.PlanReady}); open questions they leave stop the run (${WorkflowRunEvent.NeedsInput}). At most one, before any agentflow.execute.`,
  `agentflow.execute: approves the plan and implements it, pushing a branch to every repository it changed (${WorkflowRunEvent.ExecuteStarted}, ${WorkflowRunEvent.ExecuteCompleted}). The pull request comes from a create pull request action.`,
  `agent: one instruction (plain text or a toolkit command) in the run's workspace. questions: ask stops for answers (${WorkflowRunEvent.NeedsInput}); finish: push pushes like EXECUTE; reply: and document: hand its files to later actions ({{steps.<id>.reply}}) and to the project's documents.`,
  `approval: the run waits (${WorkflowRunEvent.NeedsInput}) until an org admin approves or rejects on the run page; a rejection ends the run with ${WorkflowRunEvent.Failed}.`,
  `After the last step the run ends with ${WorkflowRunEvent.Succeeded}. A failed or cancelled plan, implement or agent step can be retried from the run page.`,
];

export const WORKFLOW_ORCHESTRATOR_KEY_DOCS: Record<
  string,
  WorkflowYamlKeyDoc
> = {
  concurrency: {
    detail: "supersede (default) | queue",
    info: "A message arriving while a turn runs: supersede stops that turn and starts one with all messages; queue lets it finish and answers the new messages next.",
  },
  debounceSeconds: {
    detail: `0 to ${ORCHESTRATOR_DEBOUNCE_SECONDS_MAX}, default ${ORCHESTRATOR_DEBOUNCE_SECONDS_DEFAULT}`,
    info: "Quiet time after the last message before a turn starts, so a burst of messages is answered once. 0 starts at once.",
  },
  turnTimeoutMinutes: {
    detail: `1 to ${ORCHESTRATOR_TURN_TIMEOUT_MINUTES_MAX}, default ${ORCHESTRATOR_TURN_TIMEOUT_MINUTES_DEFAULT}`,
    info: "A turn running longer than this is stopped.",
  },
  cancelOn: {
    detail:
      "list of status_changed | label_added | label_removed, default [status_changed, label_removed]",
    info: "Which ticket changes may cancel the tasks of the status or label the ticket left (task_cancel). [] means the orchestrator never cancels. A comment, question or reply never cancels; they are not options.",
  },
};
