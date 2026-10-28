import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  resolveWorkflowOrchestratorConfig,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type Workflow,
  type WorkflowAction,
  WorkflowActionStage,
  type WorkflowAgentConfig,
  type WorkflowPrdRule,
  WorkflowRunEvent,
  type WorkflowTrigger,
  workflowInstructionConfigSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
// Cross-slice: a workflow's own process is the project process, nested.
import { processYamlValue } from "@repo/app/projects/lib/process-yaml";
import { Document, isMap, isPair, isScalar, isSeq } from "yaml";
import { findProvider } from "./workflow-catalog";
import {
  BUILT_IN_HTTP_REFERENCE,
  getPostActionEvents,
  type WorkflowYamlCatalog,
  WorkflowYamlList,
} from "./workflow-yaml-schema";

/**
 * A workflow as the YAML the workflow editor shows (see workflow-yaml.ts):
 * everything it refers to named the way people read it, ids kept only where
 * a name is unknown or shared.
 */

/**
 * The YAML of a saved workflow. `catalog` turns ids back into names; an id
 * whose name is unknown or shared by several entries stays an id.
 */
export function workflowToYaml(
  workflow: Workflow,
  catalog: WorkflowYamlCatalog
): string {
  const triggers = sortByPosition(workflow.triggers).map((trigger) =>
    compact({
      project:
        workflow.project && trigger.projectId !== workflow.project.id
          ? projectReference(trigger.projectId, catalog)
          : undefined,
      connection: connectionReference(trigger),
      type: trigger.type,
      enabled: trigger.enabled ? undefined : false,
      config: nonEmpty(trigger.config),
    })
  );
  const actions = sortActions(workflow.actions).map(actionYamlValue);
  const { agent } = workflow;
  return stringifyWorkflow(
    compact({
      name: workflow.name,
      description: workflow.description || undefined,
      enabled: workflow.enabled,
      project: workflow.project
        ? projectReference(workflow.project.id, catalog, workflow.project.name)
        : "",
      triggers,
      agent: compact({
        runAs: workflow.runAsUser
          ? userReference(
              workflow.runAsUser.id,
              catalog,
              workflow.runAsUser.email
            )
          : undefined,
        runner: runnerReference(agent.computeTargetId, catalog),
        runners:
          agent.runners.length > 0
            ? agent.runners.map((rule) => ({
                runner: runnerReference(rule.computeTargetId, catalog),
                condition: rule.condition,
              }))
            : undefined,
        mode: agent.mode,
        stopOnOpenQuestions: agent.stopOnOpenQuestions,
        repository: agent.repository ?? undefined,
        prd: prdYamlValue(agent.prd),
        titleTemplate: agent.titleTemplate,
        instructions: agent.instructions || undefined,
        orchestrator: orchestratorYamlValue(agent),
        process: agent.process ? processYamlValue(agent.process) : undefined,
      }),
      actions,
    })
  );
}

/**
 * The YAML a new workflow starts from: its own HTTP endpoint as the trigger,
 * the only project and the only runner filled in when there is just one.
 */
export function newWorkflowYaml(catalog: WorkflowYamlCatalog): string {
  const webhook = findProvider(
    catalog.providers,
    IntegrationProviderKey.Webhook
  );
  const onlyName = (names: readonly string[]) =>
    names.length === 1 ? (names[0] ?? "") : "";
  const body = stringifyWorkflow({
    name: "New workflow",
    enabled: true,
    project: onlyName(catalog.projects.map((project) => project.name)),
    triggers: [
      compact({
        connection: BUILT_IN_HTTP_REFERENCE,
        type: webhook?.triggers[0]?.key ?? "",
      }),
    ],
    agent: {
      runner: onlyName(catalog.runners.map((runner) => runner.label)),
      mode: WorkflowAgentMode.PlanAndExecute,
      stopOnOpenQuestions: true,
    },
    actions: [],
  });
  return `${NEW_WORKFLOW_HEADER}${body}`;
}

const NEW_WORKFLOW_HEADER = `# A workflow: a trigger starts a run and the agent team works on the item.
# Connections are named by their key (Project → Integrations). Actions run in
# order on the run events they list (on:), workflow.triggered before the agent
# team. An action is an instruction an agent carries out on the run's source
# item, read-only unless connections: grants writes, or a type with its config.
# Ctrl+Space shows what fits where the cursor is: keys, connections, trigger and
# action types, their options, projects, runners and run events.
`;

function sortByPosition<T extends { position: number }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

/** `value` without its undefined keys, in insertion order. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function nonEmpty(
  config: Record<string, unknown>
): Record<string, unknown> | undefined {
  return Object.keys(config).length > 0 ? config : undefined;
}

/** The name when exactly one entry has it, else the id. */
function nameOrId(id: string, name: string, names: readonly string[]): string {
  return names.filter((candidate) => candidate === name).length === 1
    ? name
    : id;
}

/** The project connection key, or `http` for the built-in endpoint or call. */
function connectionReference(item: WorkflowTrigger | WorkflowAction): string {
  if (item.builtInHttp) {
    return BUILT_IN_HTTP_REFERENCE;
  }
  return item.connectionKey ?? "";
}

function projectReference(
  id: string,
  catalog: WorkflowYamlCatalog,
  fallbackName?: string
): string {
  const name =
    catalog.projects.find((project) => project.id === id)?.name ?? fallbackName;
  return name
    ? nameOrId(
        id,
        name,
        catalog.projects.map((project) => project.name)
      )
    : id;
}

function runnerReference(id: string, catalog: WorkflowYamlCatalog): string {
  const runner = catalog.runners.find((candidate) => candidate.id === id);
  return runner
    ? nameOrId(
        runner.id,
        runner.label,
        catalog.runners.map((candidate) => candidate.label)
      )
    : id;
}

function userReference(
  id: string,
  catalog: WorkflowYamlCatalog,
  email: string
): string {
  const user = catalog.users.find((candidate) => candidate.id === id);
  const address = user?.email || email;
  return address || id;
}

/** The workflow as YAML: block text for long strings, events as `[a, b]`. */
function stringifyWorkflow(value: Record<string, unknown>): string {
  const document = new Document(value);
  const actions = document.getIn([WorkflowYamlList.Actions], true);
  if (isSeq(actions)) {
    for (const item of actions.items) {
      const on = isMap(item) ? item.get("on", true) : null;
      if (isSeq(on)) {
        on.flow = true;
      }
    }
  }
  flowScalarLists(document.getIn([WorkflowYamlList.Triggers], true));
  flowScalarLists(actions);
  return document.toString({ lineWidth: 0, blockQuote: "literal" });
}

/** Short lists of plain words in configs (projectKeys, labels) read best as `[a, b]`. */
function flowScalarLists(list: unknown) {
  if (!isSeq(list)) {
    return;
  }
  for (const item of list.items) {
    flowScalarValues(isMap(item) ? item.get("config", true) : null);
  }
}

/** The lists of plain words among a mapping's values, written as `[a, b]`. */
function flowScalarValues(map: unknown) {
  if (!isMap(map)) {
    return;
  }
  for (const pair of map.items) {
    const value = isPair(pair) ? pair.value : null;
    if (isSeq(value) && value.items.every((entry) => isScalar(entry))) {
      value.flow = true;
    }
  }
}

/** The workflow's PRD rule, left out without an instruction (every item an Issue). */
function prdYamlValue(prd: WorkflowPrdRule): WorkflowPrdRule | undefined {
  return prd.instruction ? prd : undefined;
}

/** An item of `actions`: on, then the instruction or the type and its config. */
function actionYamlValue(action: WorkflowAction): Record<string, unknown> {
  const instruction = workflowInstructionConfigSchema.safeParse(action.config);
  const isInstruction =
    action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE && instruction.success;
  return compact({
    on: onYamlValue(action),
    connection: action.automaticConnection
      ? undefined
      : connectionReference(action),
    instruction: isInstruction ? instruction.data.instruction : undefined,
    connections: isInstruction ? instruction.data.connections : undefined,
    type: isInstruction ? undefined : action.type,
    continueOnError: action.continueOnError ? true : undefined,
    enabled: action.enabled ? undefined : false,
    config: isInstruction ? undefined : nonEmpty(action.config),
  });
}

/** One event as a word, several as `[a, b]`. */
function onYamlValue(
  action: WorkflowAction
): WorkflowRunEvent | WorkflowRunEvent[] {
  if (action.stage === WorkflowActionStage.Pre) {
    return WorkflowRunEvent.Triggered;
  }
  const events = getPostActionEvents(action.events);
  const [only] = events;
  return events.length === 1 && only ? only : events;
}

/** Pre actions first (they run first), then by position: the run order. */
function sortActions(actions: readonly WorkflowAction[]): WorkflowAction[] {
  return [...actions].sort((left, right) => {
    if (left.stage !== right.stage) {
      return left.stage === WorkflowActionStage.Pre ? -1 : 1;
    }
    return left.position - right.position;
  });
}

function orchestratorYamlValue(agent: WorkflowAgentConfig) {
  if (agent.mode === WorkflowAgentMode.Orchestrated) {
    return resolveWorkflowOrchestratorConfig(agent);
  }
  return agent.orchestrator;
}
