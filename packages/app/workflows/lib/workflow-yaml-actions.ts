import type {
  IntegrationFieldDescriptor,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowAction,
  type WorkflowActionInput,
  WorkflowActionStage,
  WorkflowRunEvent,
  type WorkflowTrigger,
} from "@repo/api/src/types/workflow";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  WORKFLOW_EMAIL_CONFIG_FIELDS,
  workflowEmailConfigSchema,
} from "@repo/api/src/types/workflow-email";
import { YamlProblemSeverity } from "@repo/app/shared/lib/yaml-problems";
import {
  type ActionYaml,
  getPostActionEvents,
  type PreActionYaml,
  type WorkflowYaml,
  WorkflowYamlList,
} from "./workflow-yaml-schema";

/**
 * The actions of a workflow's YAML (see workflow-yaml.ts) as the API's action
 * inputs: the `actions` list, where `on` decides when each item runs, and the
 * older `preActions` / `postActions` lists. Connections are project
 * connection keys. An instruction works on the run's source item, read-only
 * unless its `connections:` grants writes. A typed action without
 * `connection` works on what the run offers (the source item, every
 * connection holding a repository of the run, or the project's only
 * connection offering the type); the API checks on save that one will. An
 * email (agentflow.email) is sent by AgentFlow itself and names none. The
 * parser hands in what resolving needs (ActionResolver), so this module
 * never imports it back.
 */

export type YamlPath = readonly (string | number)[];

export type ResolvedConnection = {
  /** The project connection key; null: the workflow's own HTTP endpoint or HTTPS call. */
  connectionKey: string | null;
  provider: IntegrationProviderSummary;
  /** How the YAML named it, for messages. */
  label: string;
};

/** What resolving actions needs from the YAML parser. */
export type ActionResolver = {
  providers: readonly IntegrationProviderSummary[];
  report(path: YamlPath, message: string, severity?: YamlProblemSeverity): void;
  reportKey(
    path: YamlPath,
    key: string,
    message: string,
    severity: YamlProblemSeverity
  ): void;
  /** A connection whose provider offers actions; null after a problem. */
  resolveConnection(
    path: YamlPath,
    reference: string
  ): ResolvedConnection | null;
  /** The config checked against the type's fields; null after a problem. */
  resolveConfig(
    path: YamlPath,
    fields: readonly IntegrationFieldDescriptor[],
    config: Record<string, unknown>
  ): Record<string, unknown> | null;
};

/**
 * Every action in the order it is saved: `preActions`, `actions`,
 * `postActions`. Null where a problem was reported.
 */
export function resolveWorkflowActions(
  resolver: ActionResolver,
  workflow: WorkflowYaml,
  saved: WorkflowAction[]
): (WorkflowActionInput | null)[] {
  const preActions = (workflow.preActions ?? []).map((action, index) =>
    resolveAction(resolver, action, [WorkflowYamlList.PreActions, index], {
      stage: WorkflowActionStage.Pre,
      events: [],
      continueOnError: action.continueOnError,
      saved,
    })
  );
  const listed = (workflow.actions ?? []).map((action, index) =>
    resolveListAction(
      resolver,
      action,
      [WorkflowYamlList.Actions, index],
      saved
    )
  );
  const postActions = (workflow.postActions ?? []).map((action, index) =>
    resolveAction(resolver, action, [WorkflowYamlList.PostActions, index], {
      stage: WorkflowActionStage.Post,
      events: getPostActionEvents(action.events),
      continueOnError: false,
      saved,
    })
  );
  reportOlderActionLists(resolver, workflow);
  return [...preActions, ...listed, ...postActions];
}

/**
 * The id of the first unclaimed saved item of the same type and connection
 * key (null: the built-in HTTP endpoint or call; AUTOMATIC_CONNECTION:
 * chosen when the action runs), among those `include` accepts. The item is
 * removed from `saved`, so no other item claims the same id.
 */
export function claimSaved<T extends WorkflowTrigger | WorkflowAction>(
  saved: T[],
  type: string,
  connectionKey: string | null,
  include: (item: T) => boolean = () => true
): string | undefined {
  const index = saved.findIndex(
    (item) =>
      include(item) && item.type === type && sameConnection(item, connectionKey)
  );
  if (index < 0) {
    return;
  }
  const [claimed] = saved.splice(index, 1);
  return claimed?.id;
}

export function unknownTypeMessage(
  type: string,
  noun: "trigger" | "action",
  source: ResolvedConnection,
  available: readonly string[]
): string {
  return available.length > 0
    ? `${type} is not a ${noun} of ${source.label} (${source.provider.displayName}). Types: ${available.join(", ")}`
    : `${source.label} (${source.provider.displayName}) offers no ${noun}s`;
}

/** Where an action runs and what it keeps from the saved workflow. */
type ActionStage = Pick<
  WorkflowActionInput,
  "stage" | "events" | "continueOnError"
> & {
  saved: WorkflowAction[];
};

/** claimSaved's marker for an action whose connection is chosen when it runs. */
const AUTOMATIC_CONNECTION = "automatic";

function resolveAction(
  resolver: ActionResolver,
  action: Pick<PreActionYaml, "connection" | "type" | "config" | "enabled">,
  path: YamlPath,
  stage: ActionStage
): WorkflowActionInput | null {
  const source = resolver.resolveConnection(
    [...path, "connection"],
    action.connection
  );
  if (!source) {
    return null;
  }
  const definition = source.provider.actions.find(
    (candidate) => candidate.key === action.type
  );
  if (!definition) {
    resolver.report(
      [...path, "type"],
      unknownTypeMessage(
        action.type,
        "action",
        source,
        source.provider.actions.map((item) => item.key)
      )
    );
    return null;
  }
  const config = resolver.resolveConfig(
    [...path, "config"],
    definition.configFields,
    action.config
  );
  if (!config) {
    return null;
  }
  return withSavedId(
    {
      connectionKey: source.connectionKey,
      automaticConnection: false,
      type: action.type,
      config,
      stage: stage.stage,
      events: stage.events,
      continueOnError: stage.continueOnError,
      enabled: action.enabled,
    },
    stage
  );
}

/** An item of `actions`: `on` decides its stage and events. */
function resolveListAction(
  resolver: ActionResolver,
  action: ActionYaml,
  path: YamlPath,
  saved: WorkflowAction[]
): WorkflowActionInput | null {
  const pre = action.on.includes(WorkflowRunEvent.Triggered);
  const stage: ActionStage = {
    stage: pre ? WorkflowActionStage.Pre : WorkflowActionStage.Post,
    events: pre ? [] : getPostActionEvents(action.on),
    continueOnError: action.continueOnError,
    saved,
  };
  if (action.instruction) {
    return resolveInstruction(resolver, action, path, stage);
  }
  const type = action.type ?? "";
  if (type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return resolveEmail(resolver, action, path, stage);
  }
  if (action.connection) {
    return resolveAction(
      resolver,
      { ...action, connection: action.connection, type },
      path,
      stage
    );
  }
  return resolveAutomaticAction(resolver, { ...action, type }, path, stage);
}

/**
 * An instruction: on the run's source item, read-only unless its
 * `connections:` grants writes (checked against the project's connections
 * by the API on save).
 */
function resolveInstruction(
  _resolver: ActionResolver,
  action: ActionYaml,
  _path: YamlPath,
  stage: ActionStage
): WorkflowActionInput | null {
  const config: WorkflowActionInput["config"] = {
    instruction: action.instruction ?? "",
  };
  if (action.connections) {
    config.connections = action.connections;
  }
  return withSavedId(
    {
      connectionKey: null,
      automaticConnection: true,
      type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
      config,
      stage: stage.stage,
      events: stage.events,
      continueOnError: stage.continueOnError,
      enabled: action.enabled,
    },
    stage
  );
}

/**
 * An email: sent through AgentFlow's own mail relay to the addresses of its
 * config, so it names no connection.
 */
function resolveEmail(
  resolver: ActionResolver,
  action: ActionYaml,
  path: YamlPath,
  stage: ActionStage
): WorkflowActionInput | null {
  if (action.connection) {
    resolver.report(
      [...path, "connection"],
      "AgentFlow sends the email itself: leave out connection:"
    );
    return null;
  }
  const config = resolver.resolveConfig(
    [...path, "config"],
    WORKFLOW_EMAIL_CONFIG_FIELDS,
    action.config
  );
  if (!config) {
    return null;
  }
  const checked = workflowEmailConfigSchema.safeParse(config);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      const at = issue.path.flatMap((segment) =>
        typeof segment === "symbol" ? [] : [segment]
      );
      resolver.report([...path, "config", ...at], issue.message);
    }
    return null;
  }
  return withSavedId(
    {
      connectionKey: null,
      automaticConnection: true,
      type: WORKFLOW_EMAIL_ACTION_TYPE,
      config,
      stage: stage.stage,
      events: stage.events,
      continueOnError: stage.continueOnError,
      enabled: action.enabled,
    },
    stage
  );
}

/**
 * A typed action without `connection`: checked against the provider that
 * offers the type; the API checks on save that the run will have such a
 * connection (the trigger's, or the project's repositories').
 */
function resolveAutomaticAction(
  resolver: ActionResolver,
  action: Pick<ActionYaml, "config" | "enabled"> & { type: string },
  path: YamlPath,
  stage: ActionStage
): WorkflowActionInput | null {
  const definition = resolver.providers
    .flatMap((provider) => provider.actions)
    .find((candidate) => candidate.key === action.type);
  if (!definition) {
    resolver.report(
      [...path, "type"],
      `${action.type || "The type"} is not an action type of any connection. Ctrl+Space lists them; name the connection for a type it offers.`
    );
    return null;
  }
  const config = resolver.resolveConfig(
    [...path, "config"],
    definition.configFields,
    action.config
  );
  if (!config) {
    return null;
  }
  return withSavedId(
    {
      connectionKey: null,
      automaticConnection: true,
      type: action.type,
      config,
      stage: stage.stage,
      events: stage.events,
      continueOnError: stage.continueOnError,
      enabled: action.enabled,
    },
    stage
  );
}

/** The input with the id of the saved action it continues, when there is one. */
function withSavedId(
  input: WorkflowActionInput,
  stage: ActionStage
): WorkflowActionInput {
  const id = claimSaved(
    stage.saved,
    input.type,
    input.automaticConnection ? AUTOMATIC_CONNECTION : input.connectionKey,
    (saved) => saved.stage === stage.stage
  );
  return id ? { ...input, id } : input;
}

/** The older lists still read; the editor writes `actions`. */
function reportOlderActionLists(
  resolver: ActionResolver,
  workflow: WorkflowYaml
) {
  const older: [WorkflowYamlList, string, unknown[] | null | undefined][] = [
    [
      WorkflowYamlList.PreActions,
      WorkflowRunEvent.Triggered,
      workflow.preActions,
    ],
    [WorkflowYamlList.PostActions, "the events", workflow.postActions],
  ];
  for (const [list, on, items] of older) {
    if (items && items.length > 0) {
      resolver.reportKey(
        [],
        list,
        `${list} is the older form: write these under actions: with on: ${on}`,
        YamlProblemSeverity.Warning
      );
    }
  }
}

function sameConnection(
  item: WorkflowTrigger | WorkflowAction,
  connectionKey: string | null
): boolean {
  const automatic = "automaticConnection" in item && item.automaticConnection;
  if (connectionKey === AUTOMATIC_CONNECTION) {
    return automatic;
  }
  if (connectionKey === null) {
    return item.builtInHttp;
  }
  return !automatic && item.connectionKey === connectionKey;
}
