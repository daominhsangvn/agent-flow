import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  type SaveWorkflowInput,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionStage,
  type WorkflowAgentConfig,
  WorkflowRunEvent,
  workflowActionStageSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { withDb } from "@repo/database";
import type { z } from "zod";
import { computeTargetsService } from "@/app/compute-targets/service";
import { checkProcessToolkit } from "@/app/projects/project-process-service";
import { WebhookTriggerType } from "@/lib/integrations/providers/webhook/inbound-event";
import { WebhookActionType } from "@/lib/integrations/providers/webhook/post-action";
import {
  findActionDefinition,
  findTriggerDefinition,
  getIntegrationProvider,
} from "@/lib/integrations/registry";
import { toJsonObject } from "./engine/run-data";

/**
 * Validation of a saved workflow (docs/workflows.md "API"): project and
 * run-as user in the org, a compute target the run-as user may use (owned or
 * org-shared when the caller runs the workflow as themselves; org-shared only
 * when it runs as another member, so an admin can never reach a member's
 * private desktop), every trigger/action on a connection of the org (a
 * disabled connection is allowed: the engine skips it at run time) with a
 * type its provider offers and a config its schema accepts. Pre actions run
 * on run.triggered; post actions need at least one other run event. Action
 * positions count per stage, in request order, and messages name actions
 * the way the editor does ("Pre action 1", "Post action 2"). Returns the
 * values to persist (parsed configs) or a user-facing message.
 */

type ValidatedChild = {
  id?: string;
  connectionId: string;
  type: string;
  config: JsonObject;
  enabled: boolean;
  position: number;
};

/** `connectionId` null: the workflow's built-in HTTP endpoint, resolved on save. */
export type ValidatedTrigger = Omit<ValidatedChild, "connectionId"> & {
  connectionId: string | null;
};

/** `connectionId` null: the workflow's built-in HTTPS call, resolved on save. */
export type ValidatedAction = Omit<ValidatedChild, "connectionId"> & {
  connectionId: string | null;
} & ActionStageFields;

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

/** A trigger whose built-in HTTP endpoint has been resolved to its connection. */
export type PersistableTrigger = ValidatedChild;
export type PersistableAction = ValidatedChild & ActionStageFields;

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
  repository: null,
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
  const scopeError = await checkScope(organizationId, input, runAsUserId);
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
  // The workflow's own process: its toolkit must be a project repository,
  // like the project's process.
  const toolkitError = await checkProcessToolkit(
    organizationId,
    input.projectId,
    input.agent.process
  );
  if (toolkitError) {
    return Result.err(toolkitError);
  }
  const connections = await loadConnections(
    organizationId,
    input,
    context.workflowId
  );
  const triggers = validateTriggers(input, connections, existing.triggerIds);
  if (!triggers.ok) {
    return triggers;
  }
  const actions = validateActions(input, connections, existing.actionIds);
  if (!actions.ok) {
    return actions;
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

type ConnectionSummary = {
  id: string;
  name: string;
  provider: string;
};

type TriggerInput = SaveWorkflowInput["triggers"][number];
type ChildInput = Omit<TriggerInput, "connectionId"> & { connectionId: string };

type ActionInput = SaveWorkflowInput["actions"][number];

type ActionStageFields = {
  stage: WorkflowActionStage;
  events: WorkflowRunEvent[];
  continueOnError: boolean;
};

async function checkScope(
  organizationId: string,
  input: SaveWorkflowInput,
  runAsUserId: string
): Promise<string | null> {
  const [project, runAsUser] = await Promise.all([
    withDb((db) =>
      db.project.findFirst({
        where: { id: input.projectId, organizationId },
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
  if (!project) {
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

/**
 * Connections the workflow may use: the org's shared ones and its own HTTP
 * endpoint (another workflow's endpoint reads as not found).
 */
async function loadConnections(
  organizationId: string,
  input: SaveWorkflowInput,
  workflowId: string | null
): Promise<Map<string, ConnectionSummary>> {
  const ids = [
    ...new Set(
      [...input.triggers, ...input.actions].flatMap((child) =>
        child.connectionId ? [child.connectionId] : []
      )
    ),
  ];
  const rows = await withDb((db) =>
    db.integrationConnection.findMany({
      where: {
        organizationId,
        id: { in: ids },
        OR: [
          { managedByWorkflowId: null },
          ...(workflowId ? [{ managedByWorkflowId: workflowId }] : []),
        ],
      },
      select: { id: true, name: true, provider: true },
    })
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function validateTriggers(
  input: SaveWorkflowInput,
  connections: Map<string, ConnectionSummary>,
  existingIds: ReadonlySet<string>
): Result<ValidatedTrigger[], string> {
  const validated: ValidatedTrigger[] = [];
  for (const [index, trigger] of input.triggers.entries()) {
    const label = `Trigger ${index + 1}`;
    if (trigger.connectionId === null) {
      const builtIn = validateBuiltInHttpTrigger(label, trigger, existingIds);
      if (!builtIn.ok) {
        return builtIn;
      }
      validated.push({ ...builtIn.value, position: index });
      continue;
    }
    const child = { ...trigger, connectionId: trigger.connectionId };
    const base = checkChild(label, child, connections, existingIds);
    if (!base.ok) {
      return base;
    }
    const definition = findTriggerDefinition(base.value.provider, trigger.type);
    if (!definition) {
      return Result.err(unsupportedType(label, trigger.type, base.value));
    }
    const config = parseConfig(label, definition.configSchema, trigger.config);
    if (!config.ok) {
      return config;
    }
    validated.push(toValidatedChild(child, config.value, index));
  }
  return Result.ok(validated);
}

/** The workflow's own HTTP endpoint: only the generic webhook request trigger. */
function validateBuiltInHttpTrigger(
  label: string,
  trigger: TriggerInput,
  existingIds: ReadonlySet<string>
): Result<Omit<ValidatedTrigger, "position">, string> {
  if (trigger.id && !existingIds.has(trigger.id)) {
    return Result.err(`${label} does not belong to this workflow.`);
  }
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
    ...(trigger.id ? { id: trigger.id } : {}),
    connectionId: null,
    type: trigger.type,
    config: config.value,
    enabled: trigger.enabled,
  });
}

/** The workflow's built-in HTTPS call: only the generic webhook post action. */
function validateBuiltInHttpAction(
  label: string,
  action: ActionInput,
  existingIds: ReadonlySet<string>
): Result<Omit<ValidatedChild, "connectionId" | "position">, string> {
  if (action.id && !existingIds.has(action.id)) {
    return Result.err(`${label} does not belong to this workflow.`);
  }
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
  return Result.ok({
    ...(action.id ? { id: action.id } : {}),
    type: action.type,
    config: config.value,
    enabled: action.enabled,
  });
}

function validateActions(
  input: SaveWorkflowInput,
  connections: Map<string, ConnectionSummary>,
  existingIds: ReadonlySet<string>
): Result<ValidatedAction[], string> {
  const validated: ValidatedAction[] = [];
  const nextPositions = new Map<WorkflowActionStage, number>();
  for (const action of input.actions) {
    const position = nextPositions.get(action.stage) ?? 0;
    nextPositions.set(action.stage, position + 1);
    const label = `${ACTION_STAGE_LABELS[action.stage]} ${position + 1}`;
    const stageFields = toStageFields(label, action);
    if (!stageFields.ok) {
      return stageFields;
    }
    if (action.connectionId === null) {
      const builtIn = validateBuiltInHttpAction(label, action, existingIds);
      if (!builtIn.ok) {
        return builtIn;
      }
      validated.push({
        ...builtIn.value,
        connectionId: null,
        position,
        ...stageFields.value,
      });
      continue;
    }
    const child = { ...action, connectionId: action.connectionId };
    const base = checkChild(label, child, connections, existingIds);
    if (!base.ok) {
      return base;
    }
    const definition = findActionDefinition(base.value.provider, action.type);
    if (!definition) {
      return Result.err(unsupportedType(label, action.type, base.value));
    }
    const config = parseConfig(label, definition.configSchema, action.config);
    if (!config.ok) {
      return config;
    }
    validated.push({
      ...toValidatedChild(child, config.value, position),
      ...stageFields.value,
    });
  }
  return Result.ok(validated);
}

/**
 * Pre actions always run on run.triggered (submitted events are ignored) and
 * keep their continueOnError flag; post actions need at least one post event
 * and store continueOnError false (the flag only applies to pre actions).
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

/**
 * Id ownership and connection checks shared by triggers and actions. A
 * disabled connection is accepted: it ignores inbound events and its actions
 * are skipped at run time, and refusing it would block every later save of
 * the workflow (including turning it off).
 */
function checkChild(
  label: string,
  child: { id?: string; connectionId: string },
  connections: Map<string, ConnectionSummary>,
  existingIds: ReadonlySet<string>
): Result<ConnectionSummary, string> {
  if (child.id && !existingIds.has(child.id)) {
    return Result.err(`${label} does not belong to this workflow.`);
  }
  const connection = connections.get(child.connectionId);
  if (!connection) {
    return Result.err(`${label}: integration connection not found.`);
  }
  return Result.ok(connection);
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

function toValidatedChild(
  child: ChildInput & { connectionId: string },
  config: JsonObject,
  position: number
): ValidatedChild {
  return {
    ...(child.id ? { id: child.id } : {}),
    connectionId: child.connectionId,
    type: child.type,
    config,
    enabled: child.enabled,
    position,
  };
}

function unsupportedType(
  label: string,
  type: string,
  connection: ConnectionSummary
): string {
  const providerName =
    getIntegrationProvider(connection.provider)?.displayName ??
    connection.provider;
  return `${label}: "${type}" is not offered by the ${providerName} connection "${connection.name}".`;
}

/** How the editor titles action rows; positions are 1-based within the stage. */
const ACTION_STAGE_LABELS: Record<WorkflowActionStage, string> = {
  [WorkflowActionStage.Pre]: "Pre action",
  [WorkflowActionStage.Post]: "Post action",
};

export function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
}
