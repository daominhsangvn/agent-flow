import { SourceOperation } from "@repo/api/src/types/connection-grants";
import {
  IntegrationCapability,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "@repo/api/src/types/orchestrator";
import {
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_POST_ACTION_EVENTS,
  WORKFLOW_TEMPLATE_VARIABLES,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  WORKFLOW_EMAIL_CONFIG_FIELDS,
} from "@repo/api/src/types/workflow-email";
import {
  grantKeyCompletions,
  grantValueCompletions,
} from "@repo/app/integrations/lib/connection-grant-completions";
// Cross-slice: a workflow's own process is the project process, nested, so it
// gets the process editor's suggestions.
import {
  type ProcessCompletionData,
  processYamlCompletions,
} from "@repo/app/projects/lib/process-yaml-completions";
import {
  filterYamlCompletions,
  type YamlCompletion,
  YamlCompletionKind,
  type YamlCompletionResult,
} from "@repo/app/shared/lib/yaml-completion";
import {
  analyzeYamlCursor,
  type YamlCursor,
  YamlCursorKind,
  type YamlPath,
} from "@repo/app/shared/lib/yaml-cursor";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  WORKFLOW_AGENT_MODE_DESCRIPTIONS,
  WORKFLOW_AGENT_MODE_LABELS,
  WORKFLOW_RUN_EVENT_DESCRIPTIONS,
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_RUN_EVENT_ORDER,
} from "./workflow-labels";
import {
  findReferencedProvider,
  getWorkflowConnections,
  type WorkflowConnectionCapability,
} from "./workflow-yaml";
import {
  WORKFLOW_ACTION_KEY_DOCS,
  WORKFLOW_ORCHESTRATOR_KEY_DOCS,
  WORKFLOW_PRD_KEY_DOCS,
  WORKFLOW_RUNNER_RULE_KEY_DOCS,
  WORKFLOW_TRIGGER_KEY_DOCS,
  WORKFLOW_YAML_KEY_DOCS,
  type WorkflowYamlKeyDoc,
} from "./workflow-yaml-docs";
import {
  BUILT_IN_HTTP_REFERENCE,
  getPostActionEvents,
  WORKFLOW_YAML_KEYS,
  type WorkflowYamlCatalog,
  WorkflowYamlList,
} from "./workflow-yaml-schema";

/**
 * Suggestions of the workflow YAML editor: what fits where the cursor is —
 * the keys of the mapping, the org's connections, the trigger and action
 * types a connection offers, their options and allowed values, projects,
 * runners, users, run events, template variables, and inside `agent.process`
 * the project process editor's own suggestions. Pure, so the editor only
 * adapts them to its popup.
 */

export type WorkflowCompletionData = WorkflowYamlCatalog & {
  /** Full names of the chosen project's repositories. */
  repositories: readonly string[];
};

export function workflowYamlCompletions(
  text: string,
  pos: number,
  data: WorkflowCompletionData
): YamlCompletionResult | null {
  const cursor = analyzeYamlCursor(text, pos, {
    isScalarList: (path, key) => isScalarListKey(path, key, data),
  });
  if (!cursor) {
    return null;
  }
  const options = isProcessPath(cursor.path)
    ? processCompletions(cursor, text, data)
    : filterYamlCompletions(candidates(cursor, data), cursor.typed);
  return {
    from: cursor.from,
    options,
    variable: cursor.kind === YamlCursorKind.Variable,
  };
}

const PROCESS_PATH: YamlPath = ["agent", "process"];
/** Process keys whose values are lists of scalars (see the process completions). */
const PROCESS_LIST_KEYS: readonly string[] = ["show", "artifacts", "mounts"];
const BOOLEAN_KEYS: readonly string[] = [
  "enabled",
  "continueOnError",
  "stopOnOpenQuestions",
];

const BlockKind = { Map: "map", List: "list", Text: "text" } as const;
type BlockKind = (typeof BlockKind)[keyof typeof BlockKind];

const BLOCK_KEYS: Record<string, BlockKind> = {
  triggers: BlockKind.List,
  actions: BlockKind.List,
  preActions: BlockKind.List,
  postActions: BlockKind.List,
  events: BlockKind.List,
  agent: BlockKind.Map,
  repository: BlockKind.Map,
  prd: BlockKind.Map,
  orchestrator: BlockKind.Map,
  process: BlockKind.Map,
  config: BlockKind.Map,
  connections: BlockKind.Map,
  instructions: BlockKind.Text,
};

function candidates(
  cursor: YamlCursor,
  data: WorkflowCompletionData
): YamlCompletion[] {
  switch (cursor.kind) {
    case YamlCursorKind.Variable:
      return templateVariables();
    case YamlCursorKind.Item:
      return itemCandidates(cursor, data);
    case YamlCursorKind.Value:
      return valueCandidates(cursor, data);
    default:
      return keyCandidates(cursor, data);
  }
}

/** An item of `agent.runners`, as the cursor path names it. */
const RUNNER_RULE_PATH = "agent/runners/#";

function keyCandidates(
  cursor: YamlCursor,
  data: WorkflowCompletionData
): YamlCompletion[] {
  const where = cursor.path.join("/");
  const list = listOf(cursor.path);
  const docs = keyDocsAt(cursor.path, list);
  const keyed = (keys: readonly string[]) =>
    keys
      .filter((key) => !cursor.existingKeys.includes(key))
      .map((key) => keyCompletion(key, docs));
  if (where === "") {
    // The older action lists still read, but are not offered.
    return keyed(
      WORKFLOW_YAML_KEYS.workflow.filter(
        (key) =>
          key !== WorkflowYamlList.PreActions &&
          key !== WorkflowYamlList.PostActions
      )
    );
  }
  if (where === "agent") {
    return keyed(WORKFLOW_YAML_KEYS.agent);
  }
  if (where === "agent/repository") {
    return keyed(WORKFLOW_YAML_KEYS.repository);
  }
  if (where === "agent/prd") {
    return keyed(WORKFLOW_YAML_KEYS.prd);
  }
  if (where === "agent/orchestrator") {
    return keyed(WORKFLOW_YAML_KEYS.orchestrator);
  }
  if (where === RUNNER_RULE_PATH) {
    return keyed(WORKFLOW_YAML_KEYS.runnerRule);
  }
  if (list && cursor.path.length === 2) {
    const snippets =
      cursor.itemStart && Object.keys(cursor.itemValues).length === 0
        ? itemSnippets(list, data)
        : [];
    return [...snippets, ...keyed(itemKeys(list))];
  }
  if (list && cursor.path.length === 3 && cursor.path[2] === "config") {
    return configFieldsOf(cursor, list, data)
      .filter((field) => !cursor.existingKeys.includes(field.key))
      .map(configKeyCompletion);
  }
  if (isGrantsPath(cursor.path, list)) {
    return grantKeyCandidates(data).filter(
      (completion) => !cursor.existingKeys.includes(completion.label)
    );
  }
  return [];
}

function valueCandidates(
  cursor: YamlCursor,
  data: WorkflowCompletionData
): YamlCompletion[] {
  const key = cursor.key ?? "";
  const list = listOf(cursor.path);
  if (BOOLEAN_KEYS.includes(key)) {
    return booleanValues();
  }
  if (list && cursor.path.length === 2) {
    return itemValueCandidates(cursor, list, key, data);
  }
  if (list && cursor.path.length === 3 && cursor.path[2] === "config") {
    const field = configFieldsOf(cursor, list, data).find(
      (candidate) => candidate.key === key
    );
    return field ? fieldValues(field) : [];
  }
  if (isGrantsPath(cursor.path, list)) {
    return grantValueCandidates(key, data);
  }
  if (cursor.path.length === 0 && key === "project") {
    return projectValues(data);
  }
  return agentValueCandidates(cursor.path.join("/"), key, data);
}

function itemValueCandidates(
  cursor: YamlCursor,
  list: WorkflowYamlList,
  key: string,
  data: WorkflowCompletionData
): YamlCompletion[] {
  const capability = listCapability(list);
  if (key === "on" && list === WorkflowYamlList.Actions) {
    return eventValues(WORKFLOW_RUN_EVENT_ORDER);
  }
  if (key === "connection") {
    return connectionValues(data, capability);
  }
  if (key === "project" && list === WorkflowYamlList.Triggers) {
    return projectValues(data);
  }
  if (key === "type") {
    return typeValues(data, capability, cursor.itemValues.connection);
  }
  return [];
}

/** The runners, as values of `runner:`. */
function runnerValues(data: WorkflowCompletionData): YamlCompletion[] {
  return data.runners.map((runner) => ({
    ...value(
      runner.label,
      runner.description ?? "A runner of the organization"
    ),
    detail: runner.isOnline ? "online" : "offline",
  }));
}

function agentValueCandidates(
  where: string,
  key: string,
  data: WorkflowCompletionData
): YamlCompletion[] {
  if (where === RUNNER_RULE_PATH) {
    return key === "runner" ? runnerValues(data) : [];
  }
  if (where === "agent") {
    switch (key) {
      case "project":
        return projectValues(data);
      case "runner":
        return runnerValues(data);
      case "runAs":
        return data.users.map((user) => ({
          ...value(user.email, "A member of the organization"),
          detail: user.name,
        }));
      case "mode":
        return Object.values(WorkflowAgentMode).map((mode) => ({
          ...value(mode, WORKFLOW_AGENT_MODE_DESCRIPTIONS[mode]),
          detail: WORKFLOW_AGENT_MODE_LABELS[mode],
        }));
      case "titleTemplate":
        return [
          value(
            yamlScalar(WORKFLOW_DEFAULT_TITLE_TEMPLATE),
            "The source item's key and title"
          ),
        ];
      default:
        return [];
    }
  }
  if (where === "agent/orchestrator" && key === "cancelOn") {
    return ticketChangeValues();
  }
  if (where === "agent/orchestrator" && key === "concurrency") {
    return Object.values(OrchestratorConcurrency).map((concurrency) =>
      value(concurrency, ORCHESTRATOR_CONCURRENCY_DESCRIPTIONS[concurrency])
    );
  }
  if (where === "agent/repository" && key === "fullName") {
    return data.repositories.map((repository) =>
      value(repository, "A repository of the project")
    );
  }
  return [];
}

function itemCandidates(
  cursor: YamlCursor,
  data: WorkflowCompletionData
): YamlCompletion[] {
  if (cursor.key === "cancelOn") {
    return ticketChangeValues();
  }
  const list = listOf(cursor.path);
  if (!list) {
    return [];
  }
  if (cursor.key === "events" && list === WorkflowYamlList.PostActions) {
    return eventValues(WORKFLOW_POST_ACTION_EVENTS);
  }
  if (cursor.key === "on" && list === WorkflowYamlList.Actions) {
    return eventValues(WORKFLOW_POST_ACTION_EVENTS);
  }
  const field = configFieldsOf(cursor, list, data).find(
    (candidate) => candidate.key === cursor.key
  );
  return (field?.options ?? []).map((option) =>
    value(option.value, option.label)
  );
}

/**
 * A new item of a list: one snippet per connection and type it can use, and
 * for `actions` the instructions first.
 */
function itemSnippets(
  list: WorkflowYamlList,
  data: WorkflowCompletionData
): YamlCompletion[] {
  const capability = listCapability(list);
  const instructions =
    list === WorkflowYamlList.Actions
      ? [...INSTRUCTION_SNIPPETS, ...EMAIL_SNIPPETS]
      : [];
  const sources = [
    { reference: BUILT_IN_HTTP_REFERENCE, label: "HTTP" },
    ...getWorkflowConnections(data, capability).map((connection) => ({
      reference: connection.key,
      label: connection.key,
    })),
  ];
  const typed = sources.flatMap((source) => {
    const provider = findReferencedProvider(data, source.reference);
    if (!(provider && isSnippetSafe(source.reference))) {
      return [];
    }
    return provider[capabilityKey(capability)].map((definition) => {
      const required = definition.configFields.filter(
        (field) => field.required && field.defaultValue === undefined
      );
      const events = getPostActionEvents(
        ("defaultEvents" in definition ? definition.defaultEvents : []).filter(
          isPostEvent
        )
      );
      const lines = [
        `connection: ${yamlScalar(source.reference)}`,
        `  type: ${definition.key}`,
      ];
      if (list === WorkflowYamlList.Actions) {
        lines.unshift(`on: ${onSnippet(events)}`);
        lines[1] = `  ${lines[1]}`;
      }
      if (list === WorkflowYamlList.PostActions) {
        lines.push(
          `  events: [${events.join(", ") || `#{${WorkflowRunEvent.Succeeded}}`}]`
        );
      }
      if (required.length > 0) {
        lines.push("  config:");
        for (const field of required) {
          lines.push(
            `    ${field.key}: #{${field.placeholder ?? field.label}}`
          );
        }
      }
      return {
        label: `${source.label}: ${definition.displayName}`,
        insert: lines.join("\n"),
        kind: YamlCompletionKind.Snippet,
        detail: definition.key,
        info: definition.description,
      };
    });
  });
  return [...instructions, ...typed];
}

function connectionValues(
  data: WorkflowCompletionData,
  capability: WorkflowConnectionCapability
): YamlCompletion[] {
  const builtIn = {
    ...value(
      BUILT_IN_HTTP_REFERENCE,
      capability === IntegrationCapability.Triggers
        ? "The workflow's own URL: a signed HTTPS request starts a run"
        : "A plain HTTPS call to a URL"
    ),
    detail: "built in",
  };
  return [
    builtIn,
    ...getWorkflowConnections(data, capability).map((connection) => ({
      ...value(
        yamlScalar(connection.key),
        `${connection.name} (${projectName(data, connection.projectId)})`
      ),
      detail: providerName(data.providers, connection.provider),
    })),
  ];
}

function typeValues(
  data: WorkflowCompletionData,
  capability: WorkflowConnectionCapability,
  connection: string | undefined
): YamlCompletion[] {
  const provider = connection
    ? findReferencedProvider(data, connection)
    : undefined;
  const providers = provider ? [provider] : data.providers;
  return providers.flatMap((candidate) =>
    candidate[capabilityKey(capability)].map((definition) => ({
      ...value(definition.key, definition.description),
      detail: provider ? definition.displayName : candidate.displayName,
    }))
  );
}

/** The config fields of the item's type (its connection's provider first). */
function configFieldsOf(
  cursor: YamlCursor,
  list: WorkflowYamlList,
  data: WorkflowCompletionData
): readonly IntegrationFieldDescriptor[] {
  const type = cursor.itemValues.type;
  if (!type) {
    return [];
  }
  if (
    type === WORKFLOW_EMAIL_ACTION_TYPE &&
    list === WorkflowYamlList.Actions
  ) {
    return WORKFLOW_EMAIL_CONFIG_FIELDS;
  }
  const capability = listCapability(list);
  const connection = cursor.itemValues.connection;
  const provider = connection
    ? findReferencedProvider(data, connection)
    : undefined;
  for (const candidate of provider ? [provider] : data.providers) {
    const definition = candidate[capabilityKey(capability)].find(
      (item) => item.key === type
    );
    if (definition) {
      return definition.configFields;
    }
  }
  return [];
}

function fieldValues(field: IntegrationFieldDescriptor): YamlCompletion[] {
  if (field.kind === IntegrationFieldKind.Boolean) {
    return booleanValues();
  }
  return (field.options ?? []).map((option) =>
    value(yamlScalar(option.value), option.label)
  );
}

function configKeyCompletion(
  field: IntegrationFieldDescriptor
): YamlCompletion {
  const isList =
    field.kind === IntegrationFieldKind.MultiSelect ||
    field.kind === IntegrationFieldKind.StringList;
  return {
    label: field.key,
    insert: isList ? `${field.key}:\n  - ` : `${field.key}: `,
    kind: YamlCompletionKind.Key,
    detail: `${field.label}${field.required ? " (required)" : ""}`,
    info: field.description,
  };
}

function keyCompletion(
  key: string,
  docs: Record<string, WorkflowYamlKeyDoc> = WORKFLOW_YAML_KEY_DOCS
): YamlCompletion {
  const doc = docs[key] ?? WORKFLOW_YAML_KEY_DOCS[key];
  let insert = `${key}: `;
  const block = BLOCK_KEYS[key];
  if (block === BlockKind.Map) {
    insert = `${key}:\n  `;
  } else if (block === BlockKind.List) {
    insert = `${key}:\n  - `;
  } else if (block === BlockKind.Text) {
    insert = `${key}: |\n  `;
  }
  return {
    label: key,
    insert,
    kind: YamlCompletionKind.Key,
    detail: doc?.detail,
    info: doc?.info,
  };
}

function templateVariables(): YamlCompletion[] {
  return WORKFLOW_TEMPLATE_VARIABLES.filter(
    (variable) => !variable.name.includes("<")
  ).map((variable) => ({
    label: variable.name,
    insert: `${variable.name}}}`,
    kind: YamlCompletionKind.Variable,
    info: variable.description,
  }));
}

/** Inside `agent.process`: the project process editor's suggestions. */
function processCompletions(
  cursor: YamlCursor,
  text: string,
  data: WorkflowCompletionData
): YamlCompletion[] {
  const path = cursor.path.slice(PROCESS_PATH.length);
  const processData: ProcessCompletionData = {
    repositories: data.repositories,
    stepIds: processStepIds(text),
    projectConnections: data.projectConnections,
    providers: data.providers,
  };
  const { itemValues, ...rest } = cursor;
  return processYamlCompletions(
    {
      ...rest,
      path,
      stepType:
        cursor.kind !== YamlCursorKind.Variable &&
        path[0] === "steps" &&
        path[1] === "#"
          ? (itemValues.type ?? null)
          : null,
    },
    processData
  );
}

/** Ids of the nested process's steps, read from the text as far as it parses. */
function processStepIds(text: string): string[] {
  let value: unknown;
  try {
    value = parseDocument(text).toJS();
  } catch {
    return [];
  }
  const parsed = nestedProcessStepsSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.agent.process.steps.flatMap((step) => {
    const withId = stepIdSchema.safeParse(step);
    return withId.success ? [withId.data.id] : [];
  });
}

const nestedProcessStepsSchema = z.object({
  agent: z.object({
    process: z.object({ steps: z.array(z.unknown()) }),
  }),
});
const stepIdSchema = z.object({ id: z.string().min(1) });

function isProcessPath(path: YamlPath): boolean {
  return (
    path.length >= PROCESS_PATH.length &&
    PROCESS_PATH.every((key, index) => path[index] === key)
  );
}

function isScalarListKey(
  path: YamlPath,
  key: string,
  data: WorkflowCompletionData
): boolean {
  if (isProcessPath(path)) {
    return PROCESS_LIST_KEYS.includes(key);
  }
  if (path.join("/") === "agent/orchestrator") {
    return key === "cancelOn";
  }
  const list = listOf(path);
  if (!list) {
    return false;
  }
  if (path.length === 2) {
    return key === "events" || key === "on";
  }
  return path[2] === "config" && listFieldKeys(data).has(key);
}

/** Option keys that hold lists (projectKeys, labels, …) in any type. */
function listFieldKeys(data: WorkflowCompletionData): Set<string> {
  const keys = new Set<string>();
  const fieldLists = [
    WORKFLOW_EMAIL_CONFIG_FIELDS,
    ...data.providers.flatMap((provider) =>
      [...provider.triggers, ...provider.actions].map(
        (definition) => definition.configFields
      )
    ),
  ];
  for (const field of fieldLists.flat()) {
    if (
      field.kind === IntegrationFieldKind.MultiSelect ||
      field.kind === IntegrationFieldKind.StringList
    ) {
      keys.add(field.key);
    }
  }
  return keys;
}

/** The workflow list (`triggers`, …) a path is in, when it is in one item. */
function listOf(path: YamlPath): WorkflowYamlList | null {
  const [list, item] = path;
  const lists: readonly string[] = Object.values(WorkflowYamlList);
  return item === "#" && list && lists.includes(list)
    ? (list as WorkflowYamlList)
    : null;
}

function itemKeys(list: WorkflowYamlList): readonly string[] {
  switch (list) {
    case WorkflowYamlList.Triggers:
      return WORKFLOW_YAML_KEYS.trigger;
    case WorkflowYamlList.Actions:
      return WORKFLOW_YAML_KEYS.action;
    case WorkflowYamlList.PreActions:
      return WORKFLOW_YAML_KEYS.preAction;
    default:
      return WORKFLOW_YAML_KEYS.postAction;
  }
}

function listCapability(list: WorkflowYamlList): WorkflowConnectionCapability {
  return list === WorkflowYamlList.Triggers
    ? IntegrationCapability.Triggers
    : IntegrationCapability.Actions;
}

function capabilityKey(
  capability: WorkflowConnectionCapability
): "triggers" | "actions" {
  return capability === IntegrationCapability.Triggers ? "triggers" : "actions";
}

function providerName(
  providers: readonly IntegrationProviderSummary[],
  key: string
): string {
  return providers.find((provider) => provider.key === key)?.displayName ?? key;
}

function booleanValues(): YamlCompletion[] {
  return [value("true", "Yes"), value("false", "No")];
}

function value(label: string, info: string): YamlCompletion {
  return { label, insert: label, kind: YamlCompletionKind.Value, info };
}

function isPostEvent(
  event: string
): event is (typeof WORKFLOW_POST_ACTION_EVENTS)[number] {
  return (WORKFLOW_POST_ACTION_EVENTS as readonly string[]).includes(event);
}

/** `value` as a YAML scalar: quoted only when it has to be. */
function yamlScalar(text: string): string {
  return stringify(text, { lineWidth: 0 }).trim();
}

/** A snippet cannot carry a literal `#{` or `${` of a connection name. */
function isSnippetSafe(text: string): boolean {
  return !(text.includes("#{") || text.includes("${"));
}

function eventValues(events: readonly WorkflowRunEvent[]): YamlCompletion[] {
  return events.map((event) => ({
    ...value(event, WORKFLOW_RUN_EVENT_DESCRIPTIONS[event]),
    detail: WORKFLOW_RUN_EVENT_LABELS[event],
  }));
}

/** `on:` of a snippet: the type's default events, else a placeholder. */
function onSnippet(events: readonly WorkflowRunEvent[]): string {
  if (events.length === 0) {
    return `#{${WorkflowRunEvent.Succeeded}}`;
  }
  return events.length === 1 ? (events[0] ?? "") : `[${events.join(", ")}]`;
}

/** New `actions` items: an instruction before the agent team and after it. */
const INSTRUCTION_SNIPPETS: YamlCompletion[] = [
  {
    label: "Instruction before the agent team",
    insert: `on: ${WorkflowRunEvent.Triggered}\n  instruction: #{Move the issue to In Progress.}\n  connections:\n    source: [${SourceOperation.Transition}]`,
    kind: YamlCompletionKind.Snippet,
    detail: WorkflowRunEvent.Triggered,
    info: "An agent carries out the instruction on the run's source item before the agent team starts; it may only write what connections: grants.",
  },
  {
    label: "Instruction when the implementation is done",
    insert: `on: ${WorkflowRunEvent.ExecuteCompleted}\n  instruction: #{Summarize what was implemented (changed files, tests, pull request) and post it as a comment on the issue.}\n  connections:\n    source: [${SourceOperation.Comment}]`,
    kind: YamlCompletionKind.Snippet,
    detail: WorkflowRunEvent.ExecuteCompleted,
    info: "An agent reads the run's plan folder (PRD, plan, execution result, repositories) and carries out the instruction on the run's source item, writing only what connections: grants.",
  },
];

/** New `actions` items: an email when a person must answer or approve. */
const EMAIL_SNIPPETS: YamlCompletion[] = [
  {
    label: "Email when an answer or an approval is needed",
    insert: `on: ${WorkflowRunEvent.NeedsInput}\n  type: ${WORKFLOW_EMAIL_ACTION_TYPE}\n  config:\n    to: [#{ada@acme.dev}]`,
    kind: YamlCompletionKind.Snippet,
    detail: WORKFLOW_EMAIL_ACTION_TYPE,
    info: "AgentFlow emails the step's questions, or the approval it waits for, with a link to the run, through the server's mail relay (SMTP_URL). subject: and body: are optional templates.",
  },
];

function projectValues(data: WorkflowCompletionData): YamlCompletion[] {
  return data.projects.map((project) =>
    value(yamlScalar(project.name), "A project of the organization")
  );
}

function projectName(data: WorkflowCompletionData, projectId: string): string {
  return (
    data.projects.find((project) => project.id === projectId)?.name ?? "project"
  );
}

/** `actions[i].connections`: the grant map of an instruction. */
function isGrantsPath(path: YamlPath, list: WorkflowYamlList | null): boolean {
  return (
    list === WorkflowYamlList.Actions &&
    path.length === 3 &&
    path[2] === "connections"
  );
}

/** `source` and the project connection keys an instruction may be granted. */
function grantKeyCandidates(data: WorkflowCompletionData): YamlCompletion[] {
  return grantKeyCompletions(data.projectConnections, data.providers);
}

/** `read`, the source writes, or a connection's operations. */
function grantValueCandidates(
  key: string,
  data: WorkflowCompletionData
): YamlCompletion[] {
  return grantValueCompletions(key, findReferencedProvider(data, key));
}

/**
 * What the keys at a path mean: an action's and a trigger's read differently
 * (enabled, connection, …), and so does `agent.prd`'s instruction.
 */
function keyDocsAt(
  path: YamlPath,
  list: WorkflowYamlList | null
): Record<string, WorkflowYamlKeyDoc> {
  if (list === WorkflowYamlList.Actions && path.length === 2) {
    return WORKFLOW_ACTION_KEY_DOCS;
  }
  if (list === WorkflowYamlList.Triggers && path.length === 2) {
    return WORKFLOW_TRIGGER_KEY_DOCS;
  }
  if (path.join("/") === RUNNER_RULE_PATH) {
    return WORKFLOW_RUNNER_RULE_KEY_DOCS;
  }
  if (path.join("/") === "agent/prd") {
    return WORKFLOW_PRD_KEY_DOCS;
  }
  if (path.join("/") === "agent/orchestrator") {
    return WORKFLOW_ORCHESTRATOR_KEY_DOCS;
  }
  return WORKFLOW_YAML_KEY_DOCS;
}

const ORCHESTRATOR_CONCURRENCY_DESCRIPTIONS: Record<
  OrchestratorConcurrency,
  string
> = {
  [OrchestratorConcurrency.Supersede]:
    "A new message stops the running turn and starts one with all messages",
  [OrchestratorConcurrency.Queue]:
    "A new message waits until the running turn ends",
};

const TICKET_CHANGE_DESCRIPTIONS: Record<OrchestratorTicketChange, string> = {
  [OrchestratorTicketChange.StatusChanged]:
    "The ticket moved to another status",
  [OrchestratorTicketChange.LabelAdded]: "A label was added to the ticket",
  [OrchestratorTicketChange.LabelRemoved]:
    "A label was removed from the ticket",
};

function ticketChangeValues(): YamlCompletion[] {
  return Object.values(OrchestratorTicketChange).map((change) =>
    value(change, TICKET_CHANGE_DESCRIPTIONS[change])
  );
}
