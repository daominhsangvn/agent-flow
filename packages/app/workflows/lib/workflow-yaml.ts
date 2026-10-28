import {
  IntegrationCapability,
  type IntegrationFieldDescriptor,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import {
  type ProjectProcess,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import type {
  SaveWorkflowInput,
  Workflow,
  WorkflowTrigger,
  WorkflowTriggerInput,
} from "@repo/api/src/types/workflow";
import {
  parseRunnerCondition,
  type WorkflowRunnerRule,
} from "@repo/api/src/types/workflow-runner-rules";
// Cross-slice: trigger/action configs are described and validated by the
// integrations slice's descriptor-driven field model.
import {
  collectFieldValues,
  validateFieldValues,
} from "@repo/app/integrations/lib/integration-field-values";
import { checkFieldValue } from "@repo/app/integrations/lib/integration-yaml-fields";
// Cross-slice: a workflow's own process is the project process, nested.
import { processUnknownKeyProblems } from "@repo/app/projects/lib/process-yaml";
import {
  unknownYamlKeyProblems,
  type YamlProblem,
  YamlProblemSeverity,
  yamlErrorMessage,
  yamlKeyRange,
  yamlNodeRange,
  yamlProblemAt,
} from "@repo/app/shared/lib/yaml-problems";
import { type Document, isMap, isSeq, LineCounter, parseDocument } from "yaml";
import { findProvider } from "./workflow-catalog";
import {
  type ActionResolver,
  claimSaved,
  type ResolvedConnection,
  resolveWorkflowActions,
  unknownTypeMessage,
} from "./workflow-yaml-actions";
import {
  BUILT_IN_HTTP_REFERENCE,
  type TriggerYaml,
  WORKFLOW_YAML_KEYS,
  type WorkflowYaml,
  type WorkflowYamlCatalog,
  WorkflowYamlList,
  type WorkflowYamlProject,
  type WorkflowYamlUser,
  workflowYamlSchema,
} from "./workflow-yaml-schema";

/**
 * A workflow written as YAML: the text the workflow editor shows, with
 * everything it refers to named the way people read it (a connection, a
 * project or a runner by name, a user by email; an id works too), and back to
 * the `SaveWorkflowInput` the API takes, with every problem placed where it
 * is in the text so the editor can underline it.
 *
 * ```yaml
 * name: Implement Jira requirements
 * project: Web shop                   # the runs' project; a trigger may name its own
 * triggers:
 *   - connection: jira-shop           # a connection key of the project, or http
 *     type: jira.issue_assigned
 *     config:
 *       projectKeys: [PROJ]
 * agent:
 *   runner: runner-1
 *   mode: plan_and_execute
 * actions:                            # in order; workflow.triggered before the agent team
 *   - on: workflow.triggered
 *     instruction: Move the issue to In Progress.
 *   - on: workflow.completed
 *     type: local_git.create_pull_request
 *   - on: execute.completed
 *     instruction: Summarize what was implemented and comment on the issue.
 *     connections:
 *       source: [comment]               # agents only read unless granted
 * ```
 *
 * Connections are named by their project connection key (Project →
 * Integrations). An instruction works on the run's source item and is
 * read-only unless its `connections:` grants writes. A typed action without
 * `connection` works on the source item, the repositories' connections or
 * the project's only connection offering its type. The older `agent.project`
 * and `preActions` / `postActions` still read, with a warning.
 */

export type WorkflowYamlResult = {
  /** Every problem: syntax, then shape, then what the names refer to. */
  problems: YamlProblem[];
  /** The save body, when the YAML has no error (warnings allowed). */
  input: SaveWorkflowInput | null;
};

/**
 * The save body the YAML describes, or why it does not describe one. `saved`
 * is the workflow being edited: its triggers and actions keep their ids
 * (and so their run history) when an item of the same type and connection
 * is still there.
 */
export function parseWorkflowYaml(
  text: string,
  catalog: WorkflowYamlCatalog,
  saved?: Workflow
): WorkflowYamlResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      problems: document.errors.map((error) =>
        yamlProblemAt(
          lineCounter,
          error.pos[0],
          error.pos[1],
          yamlErrorMessage(error.message),
          YamlProblemSeverity.Error
        )
      ),
      input: null,
    };
  }
  const value = toPlainValue(document);
  if (!isRecord(value)) {
    return {
      problems: [
        yamlProblemAt(
          lineCounter,
          0,
          Math.max(text.length, 1),
          "Write the workflow as a mapping: name, triggers, agent, …",
          YamlProblemSeverity.Error
        ),
      ],
      input: null,
    };
  }
  const context: ResolveContext = {
    document,
    lineCounter,
    text,
    catalog,
    problems: [],
  };
  const parsed = workflowYamlSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      report(context, issue.path, issue.message);
    }
  }
  checkProcess(context, value);
  const input = parsed.success
    ? resolveWorkflow(context, parsed.data, saved)
    : null;
  const problems = [...context.problems, ...unknownKeyProblems(context)];
  const hasError = problems.some(
    (problem) => problem.severity === YamlProblemSeverity.Error
  );
  return { problems: sortProblems(problems), input: hasError ? null : input };
}

/** Every problem of the YAML (what the editor underlines). */
export function workflowYamlProblems(
  text: string,
  catalog: WorkflowYamlCatalog
): YamlProblem[] {
  return parseWorkflowYaml(text, catalog).problems;
}

/**
 * Project connections whose provider offers `capability`: those of the
 * project, else of every project once per key (completions without a
 * project yet).
 */
export function getWorkflowConnections(
  catalog: Pick<WorkflowYamlCatalog, "providers" | "projectConnections">,
  capability: WorkflowConnectionCapability,
  projectId?: string
): ProjectConnection[] {
  const seen = new Set<string>();
  return catalog.projectConnections.filter((connection) => {
    if (
      projectId ? connection.projectId !== projectId : seen.has(connection.key)
    ) {
      return false;
    }
    seen.add(connection.key);
    const provider = findProvider(catalog.providers, connection.provider);
    return (provider?.[capabilityList(capability)].length ?? 0) > 0;
  });
}

/** What a connection is used for in a workflow. */
export type WorkflowConnectionCapability =
  | typeof IntegrationCapability.Triggers
  | typeof IntegrationCapability.Actions;

/**
 * The provider a `connection:` refers to: the webhook provider for `http`,
 * else the provider of the project connection with that key (in the
 * project when given).
 */
export function findReferencedProvider(
  catalog: Pick<WorkflowYamlCatalog, "providers" | "projectConnections">,
  reference: string,
  projectId?: string
): IntegrationProviderSummary | undefined {
  if (reference === BUILT_IN_HTTP_REFERENCE) {
    return findProvider(catalog.providers, IntegrationProviderKey.Webhook);
  }
  const connection = catalog.projectConnections.find(
    (candidate) =>
      candidate.key === reference &&
      (projectId === undefined || candidate.projectId === projectId)
  );
  return connection
    ? findProvider(catalog.providers, connection.provider)
    : undefined;
}

type ResolveContext = {
  document: Document;
  lineCounter: LineCounter;
  text: string;
  catalog: WorkflowYamlCatalog;
  problems: YamlProblem[];
  /** The workflow's project, once resolved (keys of actions are its). */
  projectId?: string;
};

type Path = readonly (string | number)[];

function resolveWorkflow(
  context: ResolveContext,
  workflow: WorkflowYaml,
  saved: Workflow | undefined
): SaveWorkflowInput | null {
  const { catalog } = context;
  const agentPath = ["agent"];
  const project = resolveWorkflowProject(context, workflow);
  context.projectId = project?.id;
  const runner = resolveByIdOrName(
    context,
    [...agentPath, "runner"],
    catalog.runners,
    workflow.agent.runner,
    { noun: "runner", nameOf: (entry) => entry.label }
  );
  if (runner && !runner.isOnline) {
    report(
      context,
      [...agentPath, "runner"],
      `${runner.label} is offline: runs start only while it is online`,
      YamlProblemSeverity.Warning
    );
  }
  const runners = resolveRunnerRules(context, workflow.agent.runners);
  const runAs = workflow.agent.runAs
    ? resolveUser(context, [...agentPath, "runAs"], workflow.agent.runAs)
    : null;
  const savedTriggers = [...(saved?.triggers ?? [])];
  const savedActions = [...(saved?.actions ?? [])];
  const triggers = workflow.triggers.map((trigger, index) =>
    project
      ? resolveTrigger(context, trigger, [WorkflowYamlList.Triggers, index], {
          projectId: project.id,
          saved: savedTriggers,
        })
      : null
  );
  const actions = resolveWorkflowActions(
    actionResolver(context),
    workflow,
    savedActions
  );
  const process = parseProcess(workflow.agent.process);
  if (
    !(project && runner && runners) ||
    triggers.some((trigger) => trigger === null) ||
    actions.some((action) => action === null) ||
    process === undefined
  ) {
    return null;
  }
  const input: SaveWorkflowInput = {
    name: workflow.name,
    description: workflow.description ?? "",
    enabled: workflow.enabled,
    projectId: project.id,
    agent: {
      mode: workflow.agent.mode,
      stopOnOpenQuestions: workflow.agent.stopOnOpenQuestions,
      computeTargetId: runner.id,
      runners,
      repository: workflow.agent.repository ?? null,
      prd: workflow.agent.prd,
      instructions: workflow.agent.instructions ?? "",
      orchestrator: workflow.agent.orchestrator ?? undefined,
      titleTemplate: workflow.agent.titleTemplate,
      process,
    },
    triggers: triggers.filter((trigger) => trigger !== null),
    actions: actions.filter((action) => action !== null),
  };
  if (runAs) {
    input.runAsUserId = runAs.id;
  }
  return input;
}

/**
 * `agent.runners`: each rule's runner by name or id (an offline one is a
 * warning) and its condition, which must parse; null when any is wrong.
 */
function resolveRunnerRules(
  context: ResolveContext,
  rules: readonly { runner: string; condition: string }[]
): WorkflowRunnerRule[] | null {
  const resolved = rules.map((rule, index) => {
    const path = ["agent", "runners", index];
    const runner = resolveByIdOrName(
      context,
      [...path, "runner"],
      context.catalog.runners,
      rule.runner,
      { noun: "runner", nameOf: (entry) => entry.label }
    );
    if (runner && !runner.isOnline) {
      report(
        context,
        [...path, "runner"],
        `${runner.label} is offline: runs it is chosen for start only while it is online`,
        YamlProblemSeverity.Warning
      );
    }
    const condition = parseRunnerCondition(rule.condition);
    if (!condition.ok) {
      report(context, [...path, "condition"], condition.error);
    }
    return runner && condition.ok
      ? { computeTargetId: runner.id, condition: rule.condition }
      : null;
  });
  return resolved.every((rule) => rule !== null) ? resolved : null;
}

/** `project:` at the root, else the older `agent.project` (with a warning). */
function resolveWorkflowProject(
  context: ResolveContext,
  workflow: WorkflowYaml
): WorkflowYamlProject | null {
  const reference = workflow.project ?? workflow.agent.project;
  if (!reference) {
    return null;
  }
  const path = workflow.project ? ["project"] : ["agent", "project"];
  if (!workflow.project) {
    report(
      context,
      path,
      "agent.project is the older place: write project: at the top of the workflow",
      YamlProblemSeverity.Warning
    );
  }
  return resolveByIdOrName(context, path, context.catalog.projects, reference, {
    noun: "project",
    nameOf: (entry) => entry.name,
  });
}

function resolveTrigger(
  context: ResolveContext,
  trigger: TriggerYaml,
  path: Path,
  target: { projectId: string; saved: WorkflowTrigger[] }
): WorkflowTriggerInput | null {
  const projectId = trigger.project
    ? resolveByIdOrName(
        context,
        [...path, "project"],
        context.catalog.projects,
        trigger.project,
        { noun: "project", nameOf: (entry) => entry.name }
      )?.id
    : target.projectId;
  if (!projectId) {
    return null;
  }
  const source = resolveConnection(
    context,
    [...path, "connection"],
    trigger.connection,
    { capability: IntegrationCapability.Triggers, projectId }
  );
  if (!source) {
    return null;
  }
  const definition = source.provider.triggers.find(
    (candidate) => candidate.key === trigger.type
  );
  if (!definition) {
    report(
      context,
      [...path, "type"],
      unknownTypeMessage(
        trigger.type,
        "trigger",
        source,
        source.provider.triggers.map((item) => item.key)
      )
    );
    return null;
  }
  const config = resolveConfig(
    context,
    [...path, "config"],
    definition.configFields,
    trigger.config
  );
  if (!config) {
    return null;
  }
  const input: WorkflowTriggerInput = {
    connectionKey: source.connectionKey,
    type: trigger.type,
    config,
    enabled: trigger.enabled,
  };
  if (trigger.project) {
    input.projectId = projectId;
  }
  const id = claimSaved(target.saved, trigger.type, source.connectionKey);
  if (id) {
    input.id = id;
  }
  return input;
}

function resolveConnection(
  context: ResolveContext,
  path: Path,
  reference: string,
  target: { capability: WorkflowConnectionCapability; projectId?: string }
): ResolvedConnection | null {
  const { capability, projectId } = target;
  const { catalog } = context;
  if (reference === BUILT_IN_HTTP_REFERENCE) {
    const provider = findProvider(
      catalog.providers,
      IntegrationProviderKey.Webhook
    );
    if (!provider) {
      report(context, path, "The built-in HTTP provider is not available");
      return null;
    }
    return { connectionKey: null, provider, label: BUILT_IN_HTTP_REFERENCE };
  }
  if (!projectId) {
    return null;
  }
  const usable = getWorkflowConnections(catalog, capability, projectId);
  const connection = usable.find((entry) => entry.key === reference);
  if (!connection) {
    const projectName =
      catalog.projects.find((project) => project.id === projectId)?.name ??
      "the project";
    const keys = [BUILT_IN_HTTP_REFERENCE, ...usable.map((entry) => entry.key)];
    report(
      context,
      path,
      `${projectName} has no ${capability === IntegrationCapability.Triggers ? "trigger" : "action"} connection "${reference}". Keys: ${keys.join(", ")}. Add connections on the project's Integrations tab.`
    );
    return null;
  }
  const provider = findProvider(catalog.providers, connection.provider);
  if (!provider) {
    report(
      context,
      path,
      `The provider of ${connection.name} is no longer available`
    );
    return null;
  }
  return { connectionKey: connection.key, provider, label: connection.key };
}

/**
 * The config the API takes, after checking every option against the type's
 * fields: the value kinds the form would have produced, the descriptor's own
 * rules (required, URL, email), and unknown options as warnings.
 */
function resolveConfig(
  context: ResolveContext,
  path: Path,
  fields: readonly IntegrationFieldDescriptor[],
  config: Record<string, unknown>
): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  let valid = true;
  for (const [key, value] of Object.entries(config)) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      reportKey(
        context,
        path,
        key,
        `Unknown option "${key}". Options: ${fields.map((item) => item.key).join(", ") || "none"}`,
        YamlProblemSeverity.Warning
      );
      continue;
    }
    const checked = checkFieldValue(field, value);
    if (checked.ok) {
      values[key] = checked.value;
    } else {
      report(context, [...path, key], checked.message);
      valid = false;
    }
  }
  const errors = validateFieldValues(fields, values);
  for (const [key, message] of Object.entries(errors)) {
    const label = fields.find((field) => field.key === key)?.label ?? key;
    if (Object.hasOwn(values, key)) {
      report(context, [...path, key], message);
    } else {
      // A missing option is marked on `config:` (or the item, without one).
      reportKey(
        context,
        path.slice(0, -1),
        "config",
        `Add the option ${key} (${label}): ${message}`,
        YamlProblemSeverity.Error
      );
    }
    valid = false;
  }
  return valid ? collectFieldValues(fields, values).config : null;
}

type NamedLookup<T> = {
  /** What the entries are, for messages ("project", "runner", …). */
  noun: string;
  nameOf: (entry: T) => string;
  /** Names that are valid besides the entries', listed in messages. */
  extraNames?: readonly string[];
};

/**
 * The entry `reference` names: its id, else its exact name, else its name
 * ignoring case. A name several entries share needs the id.
 */
function resolveByIdOrName<T extends { id: string }>(
  context: ResolveContext,
  path: Path,
  entries: readonly T[],
  reference: string,
  lookup: NamedLookup<T>
): T | null {
  const matches = matchByIdOrName(entries, reference, lookup.nameOf);
  const [match] = matches;
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length > 1) {
    report(
      context,
      path,
      `Several ${lookup.noun}s are named "${reference}": use the id (${matches.map((entry) => entry.id).join(", ")})`
    );
    return null;
  }
  const names = [...(lookup.extraNames ?? []), ...entries.map(lookup.nameOf)];
  report(
    context,
    path,
    names.length > 0
      ? `No ${lookup.noun} "${reference}". Available: ${names.join(", ")}`
      : `No ${lookup.noun} "${reference}", and there is none yet`
  );
  return null;
}

function matchByIdOrName<T extends { id: string }>(
  entries: readonly T[],
  reference: string,
  nameOf: (entry: T) => string
): T[] {
  const byId = entries.filter((entry) => entry.id === reference);
  if (byId.length > 0) {
    return byId;
  }
  const exact = entries.filter((entry) => nameOf(entry) === reference);
  if (exact.length > 0) {
    return exact;
  }
  const lower = reference.toLowerCase();
  return entries.filter((entry) => nameOf(entry).toLowerCase() === lower);
}

/** The run-as user: by id, email or name. */
function resolveUser(
  context: ResolveContext,
  path: Path,
  reference: string
): WorkflowYamlUser | null {
  const lower = reference.toLowerCase();
  const byEmail = context.catalog.users.filter(
    (user) => user.email.toLowerCase() === lower
  );
  const [user] = byEmail;
  if (byEmail.length === 1 && user) {
    return user;
  }
  return resolveByIdOrName(context, path, context.catalog.users, reference, {
    noun: "user",
    nameOf: (entry) => entry.name,
  });
}

/**
 * The workflow's own process: null when `agent.process` is absent, the parsed
 * process when it is valid, undefined (a problem was reported) otherwise.
 */
function parseProcess(value: unknown): ProjectProcess | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = projectProcessSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function checkProcess(context: ResolveContext, value: Record<string, unknown>) {
  const agent = value.agent;
  if (
    !isRecord(agent) ||
    agent.process === undefined ||
    agent.process === null
  ) {
    return;
  }
  const parsed = projectProcessSchema.safeParse(agent.process);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      report(
        context,
        ["agent", "process", ...issue.path.map(toPathKey)],
        issue.message
      );
    }
  }
}

function unknownKeyProblems(context: ResolveContext): YamlProblem[] {
  const { document, lineCounter } = context;
  const problems = unknownYamlKeyProblems(
    document.contents,
    WORKFLOW_YAML_KEYS.workflow,
    "the workflow",
    lineCounter
  );
  const lists: [WorkflowYamlList, readonly string[], string][] = [
    [WorkflowYamlList.Triggers, WORKFLOW_YAML_KEYS.trigger, "trigger"],
    [WorkflowYamlList.Actions, WORKFLOW_YAML_KEYS.action, "action"],
    [WorkflowYamlList.PreActions, WORKFLOW_YAML_KEYS.preAction, "pre action"],
    [
      WorkflowYamlList.PostActions,
      WORKFLOW_YAML_KEYS.postAction,
      "post action",
    ],
  ];
  for (const [list, keys, noun] of lists) {
    const node = document.getIn([list], true);
    const items = isSeq(node) ? node.items : [];
    items.forEach((item, index) => {
      problems.push(
        ...unknownYamlKeyProblems(
          item,
          keys,
          `${noun} ${index + 1}`,
          lineCounter
        )
      );
    });
  }
  const agent = document.getIn(["agent"], true);
  problems.push(
    ...unknownYamlKeyProblems(
      agent,
      WORKFLOW_YAML_KEYS.agent,
      "agent",
      lineCounter
    )
  );
  const runnerRules = document.getIn(["agent", "runners"], true);
  (isSeq(runnerRules) ? runnerRules.items : []).forEach((item, index) => {
    problems.push(
      ...unknownYamlKeyProblems(
        item,
        WORKFLOW_YAML_KEYS.runnerRule,
        `runner rule ${index + 1}`,
        lineCounter
      )
    );
  });
  if (isMap(agent)) {
    problems.push(
      ...unknownYamlKeyProblems(
        agent.get("repository", true),
        WORKFLOW_YAML_KEYS.repository,
        "agent.repository",
        lineCounter
      ),
      ...unknownYamlKeyProblems(
        agent.get("prd", true),
        WORKFLOW_YAML_KEYS.prd,
        "agent.prd",
        lineCounter
      ),
      ...unknownYamlKeyProblems(
        agent.get("orchestrator", true),
        WORKFLOW_YAML_KEYS.orchestrator,
        "agent.orchestrator",
        lineCounter
      ),
      ...processUnknownKeyProblems(agent.get("process", true), lineCounter)
    );
  }
  return problems;
}

function report(
  context: ResolveContext,
  path: readonly PropertyKey[],
  message: string,
  severity: YamlProblemSeverity = YamlProblemSeverity.Error
) {
  const [from, to] = yamlNodeRange(context.document, path, context.text);
  context.problems.push(
    yamlProblemAt(context.lineCounter, from, to, message, severity)
  );
}

/** A problem on the key `key` of the mapping at `path` (its value may be empty). */
function reportKey(
  context: ResolveContext,
  path: Path,
  key: string,
  message: string,
  severity: YamlProblemSeverity
) {
  const range = yamlKeyRange(context.document, path, key);
  if (!range) {
    report(context, [...path, key], message, severity);
    return;
  }
  context.problems.push(
    yamlProblemAt(context.lineCounter, range[0], range[1], message, severity)
  );
}

function sortProblems(problems: YamlProblem[]): YamlProblem[] {
  return [...problems].sort((a, b) => a.from - b.from);
}

function capabilityList(
  capability: WorkflowConnectionCapability
): "triggers" | "actions" {
  return capability === IntegrationCapability.Triggers ? "triggers" : "actions";
}

function toPathKey(key: PropertyKey): string | number {
  return typeof key === "symbol" ? String(key) : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The document as plain data; undefined when it cannot be (an alias bomb). */
function toPlainValue(document: Document): unknown {
  try {
    return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    return;
  }
}

const MAX_ALIAS_COUNT = 50;

/** What resolving the workflow's actions needs from this parser. */
function actionResolver(context: ResolveContext): ActionResolver {
  return {
    providers: context.catalog.providers,
    report: (path, message, severity) =>
      report(context, path, message, severity),
    reportKey: (path, key, message, severity) =>
      reportKey(context, path, key, message, severity),
    resolveConnection: (path, reference) =>
      resolveConnection(context, path, reference, {
        capability: IntegrationCapability.Actions,
        projectId: context.projectId,
      }),
    resolveConfig: (path, fields, config) =>
      resolveConfig(context, path, fields, config),
  };
}
