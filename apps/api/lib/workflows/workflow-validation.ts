import type { JsonObject } from "@repo/api/src/types/common";
import {
  IntegrationOperationTarget,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import type { ProjectProcess } from "@repo/api/src/types/project-process";
import { ProcessStepType } from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  type SaveWorkflowInput,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionStage,
  type WorkflowAgentConfig,
  WorkflowRunEvent,
  workflowActionStageSchema,
  workflowInstructionConfigSchema,
  workflowPrdRuleSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  workflowEmailConfigSchema,
} from "@repo/api/src/types/workflow-email";
import { withDb } from "@repo/database";
import type { z } from "zod";
import { computeTargetsService } from "@/app/compute-targets/service";
import { checkProcessToolkit } from "@/app/projects/project-process-service";
import { listProjectRepositoryCheckouts } from "@/app/projects/project-repository-checkouts";
import {
  checkConnectionGrants,
  loadProjectConnectionCatalog,
  type ProjectConnectionCatalog,
  type ProjectConnectionEntry,
  resolveKey,
} from "@/lib/integrations/connection-grants";
import { triggerContainersOutside } from "@/lib/integrations/project-connections";
import { WebhookTriggerType } from "@/lib/integrations/providers/webhook/inbound-event";
import { WebhookActionType } from "@/lib/integrations/providers/webhook/post-action";
import {
  findActionDefinition,
  findTriggerDefinition,
  getIntegrationProvider,
} from "@/lib/integrations/registry";
import { actionTarget } from "@/lib/integrations/types";
import { toJsonObject } from "./engine/run-data";

/**
 * Validation of a saved workflow (docs/workflows.md "API"): projects and
 * run-as user in the org, a compute target the run-as user may use (owned or
 * org-shared when the caller runs the workflow as themselves; org-shared only
 * when it runs as another member, so an admin can never reach a member's
 * private desktop), and every trigger and action on a project connection.
 *
 * - Each trigger belongs to a project (its own or the workflow's) and names a
 *   connection key of that project; its container filter (Jira projectKeys,
 *   Azure DevOps projects) stays within the project connection's.
 * - An action's key must exist in every project the triggers use, with the
 *   same provider; an action on the source item with a key only runs for
 *   runs from that connection.
 * - An action without a connection: an instruction (read-only unless its
 *   `connections:` grant writes), a source item action (a trigger's provider
 *   offers it), a pull request (a repository connection offers it), or any
 *   other type the project has exactly one connection for.
 * - Agent steps of the workflow's own process grant connections like
 *   instructions.
 *
 * Pre actions run on workflow.triggered; post actions need at least one other
 * run event. Actions keep their request order as their position, and
 * messages name them the way the editor does ("Action 2"). Returns the values
 * to persist (parsed configs) or a user-facing message.
 */

type ValidatedChildBase = {
  id?: string;
  type: string;
  config: JsonObject;
  enabled: boolean;
  position: number;
};

export type ValidatedTrigger = ValidatedChildBase & {
  projectId: string;
  /** Null for the workflow's built-in HTTP endpoint. */
  projectConnectionId: string | null;
  /** The organization connection; null: the built-in HTTP endpoint, resolved on save. */
  connectionId: string | null;
};

export type ValidatedAction = ValidatedChildBase & {
  connectionKey: string | null;
  automaticConnection: boolean;
} & ActionStageFields;

/** A trigger whose built-in HTTP endpoint has been resolved to its connection. */
export type PersistableTrigger = Omit<ValidatedTrigger, "connectionId"> & {
  connectionId: string;
};

/** `connectionId` is set only for the built-in HTTPS call. */
export type PersistableAction = Omit<ValidatedAction, "automaticConnection"> & {
  connectionId: string | null;
};

export type ValidatedWorkflow = {
  name: string;
  description: string;
  enabled: boolean;
  projectId: string;
  runAsUserId: string;
  agentConfig: JsonObject;
  triggers: ValidatedTrigger[];
  actions: ValidatedAction[];
};

/** Ids the workflow already owns; only these may be sent back on update. */
export type ExistingChildIds = {
  triggerIds: ReadonlySet<string>;
  actionIds: ReadonlySet<string>;
};

export type WorkflowValidationContext = {
  organizationId: string;
  /** The admin saving (or turning on) the workflow. */
  callerId: string;
  /**
   * Used when the input omits runAsUserId: the caller on create, the stored
   * run-as user on update.
   */
  defaultRunAsUserId: string;
  existing: ExistingChildIds;
  /** The workflow being updated; null on create. Its own HTTP endpoint is usable. */
  workflowId: string | null;
};

/** Shown for a stored agent config that no longer parses (never written by the API). */
export const FALLBACK_AGENT_CONFIG: WorkflowAgentConfig = {
  mode: WorkflowAgentMode.PlanAndExecute,
  stopOnOpenQuestions: true,
  computeTargetId: "",
  runners: [],
  repository: null,
  prd: workflowPrdRuleSchema.parse({}),
  instructions: "",
  titleTemplate: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  process: null,
};

export async function validateWorkflowInput(
  context: WorkflowValidationContext,
  input: SaveWorkflowInput
): Promise<Result<ValidatedWorkflow, string>> {
  const { organizationId, existing } = context;
  const runAsUserId = input.runAsUserId ?? context.defaultRunAsUserId;
  const projectIds = triggerProjectIds(input);
  const scopeError = await checkScope(organizationId, projectIds, runAsUserId);
  if (scopeError) {
    return Result.err(scopeError);
  }
  const targetError = await checkComputeTarget({
    organizationId,
    computeTargetId: input.agent.computeTargetId,
    runAsUserId,
    callerId: context.callerId,
  });
  if (targetError) {
    return Result.err(targetError);
  }
  // Each runner rule's runner follows the same access rule as the default.
  for (const [index, rule] of (input.agent.runners ?? []).entries()) {
    const ruleError = await checkComputeTarget({
      organizationId,
      computeTargetId: rule.computeTargetId,
      runAsUserId,
      callerId: context.callerId,
    });
    if (ruleError) {
      return Result.err(`Runner rule ${index + 1}: ${ruleError}`);
    }
  }
  const orchestratedError = checkOrchestrated(input);
  if (orchestratedError) {
    return Result.err(orchestratedError);
  }
  const toolkitError = await checkToolkits(
    organizationId,
    projectIds,
    input.agent.process
  );
  if (toolkitError) {
    return Result.err(toolkitError);
  }
  const catalog = await loadProjectConnectionCatalog(
    organizationId,
    projectIds
  );
  const triggers = validateTriggers(input, catalog, existing.triggerIds);
  if (!triggers.ok) {
    return triggers;
  }
  const checks = await buildActionChecks({
    organizationId,
    input,
    catalog,
    triggers: triggers.value,
    existingIds: existing.actionIds,
  });
  const actions = validateActions(input, checks);
  if (!actions.ok) {
    return actions;
  }
  const processError = checkProcessGrants(input.agent.process, checks);
  if (processError) {
    return Result.err(processError);
  }
  return Result.ok({
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    projectId: input.projectId,
    runAsUserId,
    agentConfig: toJsonObject(input.agent),
    triggers: triggers.value,
    actions: actions.value,
  });
}

/** Stored action events, keeping only known run events. */
export function readActionEvents(events: string[]): WorkflowRunEvent[] {
  return events.flatMap((event) => {
    const parsed = workflowRunEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Stored action stage; unknown values read as post (the column default). */
export function readActionStage(stage: string): WorkflowActionStage {
  const parsed = workflowActionStageSchema.safeParse(stage);
  return parsed.success ? parsed.data : WorkflowActionStage.Post;
}

export function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
}

type TriggerInput = SaveWorkflowInput["triggers"][number];
type ActionInput = SaveWorkflowInput["actions"][number];

type ActionStageFields = {
  stage: WorkflowActionStage;
  events: WorkflowRunEvent[];
  continueOnError: boolean;
};

type ActionChecks = {
  catalog: ProjectConnectionCatalog;
  existingIds: ReadonlySet<string>;
  /** The projects of the workflow's triggers. */
  projectIds: string[];
  /** Providers a run's source connection can have (the triggers'). */
  sourceProviders: string[];
  /** Providers of the trigger projects' repository connections. */
  repositoryProviders: string[];
};

type ValidatedActionTarget = Omit<
  ValidatedAction,
  "position" | keyof ActionStageFields
>;

/** The workflow's project and every trigger's own project, deduplicated. */
function triggerProjectIds(input: SaveWorkflowInput): string[] {
  return [
    ...new Set([
      input.projectId,
      ...input.triggers.flatMap((trigger) =>
        trigger.projectId ? [trigger.projectId] : []
      ),
    ]),
  ];
}

async function checkScope(
  organizationId: string,
  projectIds: readonly string[],
  runAsUserId: string
): Promise<string | null> {
  const [projects, runAsUser] = await Promise.all([
    withDb((db) =>
      db.project.findMany({
        where: { id: { in: [...projectIds] }, organizationId },
        select: { id: true },
      })
    ),
    withDb((db) =>
      db.user.findFirst({
        where: { id: runAsUserId, organizationId, active: true },
        select: { id: true },
      })
    ),
  ]);
  if (projects.length !== projectIds.length) {
    return "Project not found in this organization.";
  }
  if (!runAsUser) {
    return "The run-as user must be an active member of the organization.";
  }
  return null;
}

/**
 * Running as yourself: your own target or one shared with the org. Running
 * as another member: only a target shared with the org, never that member's
 * private desktop (sharing is the owner's opt-in to other people's work).
 */
async function checkComputeTarget(input: {
  organizationId: string;
  computeTargetId: string;
  runAsUserId: string;
  callerId: string;
}): Promise<string | null> {
  const { organizationId, computeTargetId, runAsUserId } = input;
  if (runAsUserId !== input.callerId) {
    const target = await computeTargetsService.findAccessibleById(
      computeTargetId,
      organizationId,
      runAsUserId
    );
    return target?.isSharedWithOrg
      ? null
      : "The compute target must be shared with the organization when the workflow runs as another member. Share the target, or run the workflow as yourself.";
  }
  const target =
    (await computeTargetsService.findOwnedById(
      computeTargetId,
      organizationId,
      runAsUserId
    )) ??
    (await computeTargetsService.findAccessibleById(
      computeTargetId,
      organizationId,
      runAsUserId
    ));
  return target
    ? null
    : "The compute target was not found, or it is neither owned by nor shared with the run-as user.";
}

/** The workflow's own process: its toolkit must be a repository of every trigger project. */
async function checkToolkits(
  organizationId: string,
  projectIds: readonly string[],
  process: ProjectProcess | null
): Promise<string | null> {
  for (const projectId of projectIds) {
    const error = await checkProcessToolkit(organizationId, projectId, process);
    if (error) {
      return error;
    }
  }
  return null;
}

function validateTriggers(
  input: SaveWorkflowInput,
  catalog: ProjectConnectionCatalog,
  existingIds: ReadonlySet<string>
): Result<ValidatedTrigger[], string> {
  const validated: ValidatedTrigger[] = [];
  for (const [index, trigger] of input.triggers.entries()) {
    const label = `Trigger ${index + 1}`;
    if (trigger.id && !existingIds.has(trigger.id)) {
      return Result.err(`${label} does not belong to this workflow.`);
    }
    const projectId = trigger.projectId ?? input.projectId;
    const checked =
      trigger.connectionKey === null
        ? validateBuiltInHttpTrigger(label, trigger)
        : validateConnectionTrigger(label, trigger, {
            key: trigger.connectionKey,
            entry: catalog.find(projectId, trigger.connectionKey),
            projectName: catalog.projectName(projectId),
          });
    if (!checked.ok) {
      return checked;
    }
    validated.push({
      ...(trigger.id ? { id: trigger.id } : {}),
      ...checked.value,
      projectId,
      type: trigger.type,
      enabled: trigger.enabled,
      position: index,
    });
  }
  return Result.ok(validated);
}

type TriggerTarget = Pick<
  ValidatedTrigger,
  "projectConnectionId" | "connectionId" | "config"
>;

/** The workflow's own HTTP endpoint: only the generic webhook request trigger. */
function validateBuiltInHttpTrigger(
  label: string,
  trigger: TriggerInput
): Result<TriggerTarget, string> {
  if (trigger.type !== WebhookTriggerType.Request) {
    return Result.err(
      `${label}: the workflow's HTTP endpoint only offers "${WebhookTriggerType.Request}".`
    );
  }
  const definition = findTriggerDefinition(
    IntegrationProviderKey.Webhook,
    trigger.type
  );
  if (!definition) {
    return Result.err(`${label}: the HTTP request trigger is unavailable.`);
  }
  const config = parseConfig(label, definition.configSchema, trigger.config);
  if (!config.ok) {
    return config;
  }
  return Result.ok({
    projectConnectionId: null,
    connectionId: null,
    config: config.value,
  });
}

function validateConnectionTrigger(
  label: string,
  trigger: TriggerInput,
  target: {
    key: string;
    entry: ProjectConnectionEntry | null;
    projectName: string;
  }
): Result<TriggerTarget, string> {
  const { entry } = target;
  if (!entry) {
    return Result.err(
      `${label}: project ${target.projectName} has no connection "${target.key}". Add it on the project's Integrations tab.`
    );
  }
  const definition = findTriggerDefinition(entry.provider, trigger.type);
  if (!definition) {
    return Result.err(unsupportedType(label, trigger.type, entry));
  }
  const config = parseConfig(label, definition.configSchema, trigger.config);
  if (!config.ok) {
    return config;
  }
  const outside = triggerContainersOutside(
    entry.provider,
    entry.settings,
    config.value
  );
  if (outside.length > 0) {
    return Result.err(
      `${label}: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not in the settings of connection "${entry.key}". Add ${outside.length === 1 ? "it" : "them"} to the project connection or remove ${outside.length === 1 ? "it" : "them"} from the trigger.`
    );
  }
  return Result.ok({
    projectConnectionId: entry.id,
    connectionId: entry.connectionId,
    config: config.value,
  });
}

async function buildActionChecks(input: {
  organizationId: string;
  input: SaveWorkflowInput;
  catalog: ProjectConnectionCatalog;
  triggers: readonly ValidatedTrigger[];
  existingIds: ReadonlySet<string>;
}): Promise<ActionChecks> {
  const projectIds = [
    ...new Set(input.triggers.map((trigger) => trigger.projectId)),
  ];
  const sourceProviders = input.triggers.flatMap((trigger, index) => {
    const key = input.input.triggers[index]?.connectionKey ?? null;
    if (key === null) {
      return [IntegrationProviderKey.Webhook];
    }
    const entry = input.catalog.find(trigger.projectId, key);
    return entry ? [entry.provider] : [];
  });
  const needsRepositories = input.input.actions.some(
    (action) => action.automaticConnection
  );
  const repositoryProviders = needsRepositories
    ? await loadRepositoryProviders(input.organizationId, projectIds)
    : [];
  return {
    catalog: input.catalog,
    existingIds: input.existingIds,
    projectIds,
    sourceProviders: [...new Set(sourceProviders)],
    repositoryProviders,
  };
}

async function loadRepositoryProviders(
  organizationId: string,
  projectIds: readonly string[]
): Promise<string[]> {
  const providers = new Set<string>();
  for (const projectId of projectIds) {
    const checkouts = await listProjectRepositoryCheckouts(
      organizationId,
      projectId
    );
    for (const checkout of checkouts) {
      providers.add(checkout.provider);
    }
  }
  return [...providers];
}

function validateActions(
  input: SaveWorkflowInput,
  checks: ActionChecks
): Result<ValidatedAction[], string> {
  const validated: ValidatedAction[] = [];
  for (const [position, action] of input.actions.entries()) {
    const label = `Action ${position + 1}`;
    if (action.id && !checks.existingIds.has(action.id)) {
      return Result.err(`${label} does not belong to this workflow.`);
    }
    const stageFields = toStageFields(label, action);
    if (!stageFields.ok) {
      return stageFields;
    }
    const target = validateActionTarget(label, action, checks);
    if (!target.ok) {
      return target;
    }
    validated.push({ ...target.value, position, ...stageFields.value });
  }
  return Result.ok(validated);
}

/** The action's connection (by key, built-in or automatic), type and config. */
function validateActionTarget(
  label: string,
  action: ActionInput,
  checks: ActionChecks
): Result<ValidatedActionTarget, string> {
  if (action.type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return validateInstruction(label, action, checks);
  }
  if (action.type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return validateEmail(label, action);
  }
  if (action.automaticConnection) {
    return validateAutomaticAction(label, action, checks);
  }
  if (action.connectionKey === null) {
    return validateBuiltInHttpAction(label, action);
  }
  const resolved = resolveKey(
    checks.catalog,
    checks.projectIds,
    action.connectionKey
  );
  if (!resolved.ok) {
    return Result.err(`${label}: ${resolved.error}`);
  }
  const definition = findActionDefinition(resolved.value.provider, action.type);
  if (!definition) {
    return Result.err(
      `${label}: "${action.type}" is not offered by ${providerName(resolved.value.provider)} connection "${action.connectionKey}".`
    );
  }
  const config = parseConfig(label, definition.configSchema, action.config);
  if (!config.ok) {
    return config;
  }
  return Result.ok(
    toActionTarget(action, config.value, {
      connectionKey: action.connectionKey,
      automaticConnection: false,
    })
  );
}

/**
 * An instruction works on the run's source and reads only, unless its
 * `connections:` grant lists writes; it never names a connection itself.
 */
function validateInstruction(
  label: string,
  action: ActionInput,
  checks: ActionChecks
): Result<ValidatedActionTarget, string> {
  if (action.connectionKey !== null) {
    return Result.err(
      `${label}: an instruction works on the run's source item; list the other connections it may use under connections:.`
    );
  }
  const config = workflowInstructionConfigSchema.safeParse(action.config);
  if (!config.success) {
    return Result.err(`${label}: ${describeIssues(config.error.issues)}`);
  }
  const grantError = checkConnectionGrants({
    label,
    grants: config.data.connections,
    catalog: checks.catalog,
    projectIds: checks.projectIds,
    sourceProviders: checks.sourceProviders,
  });
  if (grantError) {
    return Result.err(grantError);
  }
  return Result.ok(
    toActionTarget(action, toJsonObject(config.data), {
      connectionKey: null,
      automaticConnection: true,
    })
  );
}

/** An email goes out through the server's mail relay: it names no connection. */
function validateEmail(
  label: string,
  action: ActionInput
): Result<ValidatedActionTarget, string> {
  if (action.connectionKey !== null || !action.automaticConnection) {
    return Result.err(
      `${label}: an email is sent by AgentFlow itself; leave out connection:.`
    );
  }
  const config = workflowEmailConfigSchema.safeParse(action.config);
  if (!config.success) {
    return Result.err(`${label}: ${describeIssues(config.error.issues)}`);
  }
  return Result.ok(
    toActionTarget(action, toJsonObject(config.data), {
      connectionKey: null,
      automaticConnection: true,
    })
  );
}

/**
 * No connection named: a source item action on a trigger's provider, a pull
 * request on a repository connection, else the project's only connection
 * that offers the type (in every trigger project).
 */
function validateAutomaticAction(
  label: string,
  action: ActionInput,
  checks: ActionChecks
): Result<ValidatedActionTarget, string> {
  const definition = findAutomaticDefinition(action.type, checks);
  if (!definition.ok) {
    return Result.err(`${label}: ${definition.error}`);
  }
  const config = parseConfig(
    label,
    definition.value.configSchema,
    action.config
  );
  if (!config.ok) {
    return config;
  }
  return Result.ok(
    toActionTarget(action, config.value, {
      connectionKey: null,
      automaticConnection: true,
    })
  );
}

type ActionDefinition = NonNullable<ReturnType<typeof findActionDefinition>>;

function findAutomaticDefinition(
  type: string,
  checks: ActionChecks
): Result<ActionDefinition, string> {
  for (const provider of [
    ...checks.sourceProviders,
    ...checks.repositoryProviders,
  ]) {
    const definition = findActionDefinition(provider, type);
    const target = definition ? actionTarget(definition) : null;
    if (
      definition &&
      (target === IntegrationOperationTarget.SourceItem ||
        target === IntegrationOperationTarget.Repository)
    ) {
      return Result.ok(definition);
    }
  }
  return findSingleConnectionDefinition(type, checks);
}

/** An external type: each trigger project has exactly one connection offering it. */
function findSingleConnectionDefinition(
  type: string,
  checks: ActionChecks
): Result<ActionDefinition, string> {
  let found: ActionDefinition | null = null;
  for (const projectId of checks.projectIds) {
    const candidates = checks.catalog
      .list(projectId)
      .filter((entry) => findActionDefinition(entry.provider, type));
    const projectName = checks.catalog.projectName(projectId);
    if (candidates.length === 0) {
      return Result.err(
        `no connection of project ${projectName} offers "${type}". Add one on the project's Integrations tab.`
      );
    }
    if (candidates.length > 1) {
      return Result.err(
        `several connections of project ${projectName} offer "${type}" (${candidates.map((entry) => entry.key).join(", ")}). Name one with connection:.`
      );
    }
    found = findActionDefinition(candidates[0].provider, type);
  }
  return found
    ? Result.ok(found)
    : Result.err(`no connection offers "${type}".`);
}

/** The workflow's built-in HTTPS call: only the generic webhook post action. */
function validateBuiltInHttpAction(
  label: string,
  action: ActionInput
): Result<ValidatedActionTarget, string> {
  if (action.type !== WebhookActionType.Post) {
    return Result.err(
      `${label}: the built-in HTTPS call only offers "${WebhookActionType.Post}".`
    );
  }
  const definition = findActionDefinition(
    IntegrationProviderKey.Webhook,
    action.type
  );
  if (!definition) {
    return Result.err(`${label}: the HTTPS call action is unavailable.`);
  }
  const config = parseConfig(label, definition.configSchema, action.config);
  if (!config.ok) {
    return config;
  }
  return Result.ok(
    toActionTarget(action, config.value, {
      connectionKey: null,
      automaticConnection: false,
    })
  );
}

/** Agent steps of the workflow's own process grant connections like instructions. */
function checkProcessGrants(
  process: ProjectProcess | null,
  checks: ActionChecks
): string | null {
  for (const step of process?.steps ?? []) {
    if (step.type !== ProcessStepType.Agent) {
      continue;
    }
    const error = checkConnectionGrants({
      label: `Process step ${step.id}`,
      grants: step.connections,
      catalog: checks.catalog,
      projectIds: checks.projectIds,
      sourceProviders: checks.sourceProviders,
    });
    if (error) {
      return error;
    }
  }
  return null;
}

function toActionTarget(
  action: ActionInput,
  config: JsonObject,
  connection: Pick<ValidatedAction, "connectionKey" | "automaticConnection">
): ValidatedActionTarget {
  return {
    ...(action.id ? { id: action.id } : {}),
    ...connection,
    type: action.type,
    config,
    enabled: action.enabled,
  };
}

/**
 * Pre actions always run on workflow.triggered (submitted events are
 * ignored) and keep their continueOnError flag; post actions need at least
 * one post event and store continueOnError false (the flag only applies to
 * pre actions).
 */
function toStageFields(
  label: string,
  action: ActionInput
): Result<ActionStageFields, string> {
  if (action.stage === WorkflowActionStage.Pre) {
    return Result.ok({
      stage: WorkflowActionStage.Pre,
      events: [WorkflowRunEvent.Triggered],
      continueOnError: action.continueOnError,
    });
  }
  const events = [...new Set(action.events)];
  if (events.some((event) => !WORKFLOW_POST_ACTION_EVENTS.includes(event))) {
    return Result.err(
      `${label}: ${WorkflowRunEvent.Triggered} is reserved for pre actions.`
    );
  }
  if (events.length === 0) {
    return Result.err(`${label}: select at least one run event.`);
  }
  return Result.ok({
    stage: WorkflowActionStage.Post,
    events,
    continueOnError: false,
  });
}

function parseConfig(
  label: string,
  schema: z.ZodType<unknown>,
  config: Record<string, unknown>
): Result<JsonObject, string> {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    return Result.err(`${label}: ${describeIssues(parsed.error.issues)}`);
  }
  return Result.ok(toJsonObject(parsed.data));
}

function unsupportedType(
  label: string,
  type: string,
  entry: ProjectConnectionEntry
): string {
  return `${label}: "${type}" is not offered by ${providerName(entry.provider)} connection "${entry.key}".`;
}

function providerName(provider: string): string {
  return getIntegrationProvider(provider)?.displayName ?? provider;
}

/**
 * An orchestrated workflow starts no run: its requests go to its own
 * orchestrator (one runner, agent.runner), so it has no process of its own
 * and no runner rules.
 */
function checkOrchestrated(input: SaveWorkflowInput): string | null {
  if (input.agent.mode !== WorkflowAgentMode.Orchestrated) {
    return null;
  }
  if (input.agent.process) {
    return "A workflow handled by the orchestrator has no process of its own: remove agent.process, or choose another mode.";
  }
  if (input.agent.runners.length > 0) {
    return "A workflow handled by the orchestrator runs on one runner (agent.runner): remove agent.runners.";
  }
  return null;
}
