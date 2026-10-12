import type { IntegrationFieldDescriptor } from "@repo/api/src/types/integration";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type SaveWorkflowInput,
  type SetWorkflowEnabledInput,
  saveWorkflowInputSchema,
  WORKFLOW_RUN_ACTIVE_STATUSES,
  type Workflow,
  type WorkflowAction,
  WorkflowActionStage,
  WorkflowRunStatus,
  type WorkflowTrigger,
} from "@repo/api/src/types/workflow";
import { type Prisma, withDb } from "@repo/database";
import { z } from "zod";
import {
  ADMIN_VIEWER,
  type ConfigViewer,
  redactUrlFields,
} from "@/lib/integrations/connection/url-redaction";
import { listIntegrationProviders } from "@/lib/integrations/registry";
import { displayUserName } from "@/lib/user-display-name";
import { readAgentConfig, toJsonObject } from "./engine/run-data";
import {
  removeUnusedWorkflowHttpEndpoint,
  resolveBuiltInHttpChildren,
} from "./workflow-http-endpoint";
import {
  describeIssues,
  FALLBACK_AGENT_CONFIG,
  type PersistableAction,
  type PersistableTrigger,
  readActionEvents,
  readActionStage,
  type ValidatedWorkflow,
  validateWorkflowInput,
} from "./workflow-validation";

/**
 * Workflow CRUD for the admin UI. Saving validates every trigger and action
 * against the provider registry (connection in the org, type provided by the
 * connection's provider, config parsed by the definition's schema — the
 * parsed config is stored), the project, the run-as user and the compute
 * target. Triggers and actions are replaced as a whole on update, keeping the
 * ids the client sends back. The run-as user defaults to the caller on
 * create; on update an omitted run-as user keeps the stored one.
 *
 * Turning a workflow off never checks anything (so a workflow whose
 * dependencies broke can always be paused); turning it on re-validates the
 * stored workflow as the caller. Reads return url-kind trigger and action
 * config fields as their origin only to members who are not org admins.
 */

export type WorkflowServiceError = { status: StatusCode; message: string };

export const workflowService = {
  async list(
    organizationId: string,
    viewer: ConfigViewer
  ): Promise<Workflow[]> {
    const records = await withDb((db) =>
      db.workflow.findMany({
        where: { organizationId },
        include: WORKFLOW_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    );
    const counts = await loadRunCounts(
      organizationId,
      records.map((record) => record.id)
    );
    return records.map((record) => toWorkflowDto(record, counts, viewer));
  },

  async get(
    organizationId: string,
    id: string,
    viewer: ConfigViewer
  ): Promise<Workflow | null> {
    if (!isUuid(id)) {
      return null;
    }
    const record = await withDb((db) =>
      db.workflow.findFirst({
        where: { id, organizationId },
        include: WORKFLOW_INCLUDE,
      })
    );
    if (!record) {
      return null;
    }
    const counts = await loadRunCounts(organizationId, [record.id]);
    return toWorkflowDto(record, counts, viewer);
  },

  async create(
    organizationId: string,
    userId: string,
    input: SaveWorkflowInput
  ): Promise<Result<Workflow, WorkflowServiceError>> {
    const validated = await validateWorkflowInput(
      {
        organizationId,
        callerId: userId,
        defaultRunAsUserId: userId,
        existing: { triggerIds: new Set(), actionIds: new Set() },
        workflowId: null,
      },
      input
    );
    if (!validated.ok) {
      return badRequest(validated.error);
    }
    const saved = await withDb.tx(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          organizationId,
          createdById: userId,
          ...workflowColumns(validated.value),
        },
        select: { id: true },
      });
      const children = await saveChildren(
        { organizationId, workflowId: workflow.id, userId },
        validated.value
      );
      return children.ok ? Result.ok<string, string>(workflow.id) : children;
    });
    if (!saved.ok) {
      return badRequest(saved.error);
    }
    return await loadSaved(organizationId, saved.value);
  },

  async update(
    organizationId: string,
    id: string,
    userId: string,
    input: SaveWorkflowInput
  ): Promise<Result<Workflow, WorkflowServiceError>> {
    const existing = isUuid(id)
      ? await withDb((db) =>
          db.workflow.findFirst({
            where: { id, organizationId },
            select: {
              id: true,
              runAsUserId: true,
              triggers: { select: { id: true } },
              actions: { select: { id: true } },
            },
          })
        )
      : null;
    if (!existing) {
      return notFound();
    }
    const validated = await validateWorkflowInput(
      {
        organizationId,
        callerId: userId,
        // The stored user, unless it was deleted (then the caller, like on create).
        defaultRunAsUserId: existing.runAsUserId ?? userId,
        existing: {
          triggerIds: new Set(existing.triggers.map((trigger) => trigger.id)),
          actionIds: new Set(existing.actions.map((action) => action.id)),
        },
        workflowId: existing.id,
      },
      input
    );
    if (!validated.ok) {
      return badRequest(validated.error);
    }
    const saved = await withDb.tx(async (tx) => {
      await tx.workflow.updateMany({
        where: { id: existing.id, organizationId },
        data: workflowColumns(validated.value),
      });
      return await saveChildren(
        { organizationId, workflowId: existing.id, userId },
        validated.value
      );
    });
    if (!saved.ok) {
      return badRequest(saved.error);
    }
    return await loadSaved(organizationId, existing.id);
  },

  /**
   * PATCH /workflows/{id}: only the enabled flag. Off always succeeds; on
   * re-validates the stored workflow as the caller (400 with the message when
   * a dependency is no longer valid).
   */
  async setEnabled(
    organizationId: string,
    id: string,
    userId: string,
    input: SetWorkflowEnabledInput
  ): Promise<Result<Workflow, WorkflowServiceError>> {
    const record = isUuid(id)
      ? await withDb((db) =>
          db.workflow.findFirst({
            where: { id, organizationId },
            include: WORKFLOW_INCLUDE,
          })
        )
      : null;
    if (!record) {
      return notFound();
    }
    if (input.enabled) {
      const checked = await validateStoredWorkflow(
        organizationId,
        userId,
        record
      );
      if (!checked.ok) {
        return badRequest(checked.error);
      }
    }
    await withDb((db) =>
      db.workflow.updateMany({
        where: { id: record.id, organizationId },
        data: { enabled: input.enabled },
      })
    );
    return await loadSaved(organizationId, record.id);
  },

  async remove(
    organizationId: string,
    id: string
  ): Promise<Result<{ deleted: true }, WorkflowServiceError>> {
    if (!isUuid(id)) {
      return notFound();
    }
    const deleted = await withDb((db) =>
      db.workflow.deleteMany({ where: { id, organizationId } })
    );
    if (deleted.count === 0) {
      return notFound();
    }
    return Result.ok({ deleted: true });
  },
};

const WORKFLOW_INCLUDE = {
  project: { select: { id: true, name: true } },
  runAsUser: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  triggers: { orderBy: { position: "asc" } },
  actions: { orderBy: { position: "asc" } },
  managedConnection: { select: { id: true } },
} as const satisfies Prisma.WorkflowInclude;

type WorkflowRecord = Prisma.WorkflowGetPayload<{
  include: typeof WORKFLOW_INCLUDE;
}>;

type RunCountsByWorkflow = Map<string, Workflow["runCounts"]>;

const uuidSchema = z.uuid();

function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

function workflowColumns(validated: ValidatedWorkflow) {
  return {
    name: validated.name,
    description: validated.description,
    enabled: validated.enabled,
    projectId: validated.projectId,
    runAsUserId: validated.runAsUserId,
    agentConfig: validated.agentConfig,
  };
}

/**
 * Full replace that keeps ids: rows not sent back are deleted, rows sent with
 * their id are updated in place, rows without an id are created. The
 * workflow's built-in HTTP endpoint is created when a trigger asks for it and
 * removed once no trigger uses it. Runs inside the caller's transaction (at
 * most 10 triggers and 20 actions).
 */
async function saveChildren(
  owner: { organizationId: string; workflowId: string; userId: string },
  validated: ValidatedWorkflow
): Promise<Result<null, string>> {
  const children = await resolveBuiltInHttpChildren({
    ...owner,
    workflowName: validated.name,
    triggers: validated.triggers,
    actions: validated.actions,
  });
  if (!children.ok) {
    return children;
  }
  await replaceTriggers(
    owner.organizationId,
    owner.workflowId,
    children.value.triggers
  );
  await replaceActions(
    owner.organizationId,
    owner.workflowId,
    children.value.actions
  );
  await removeUnusedWorkflowHttpEndpoint(
    owner.organizationId,
    owner.workflowId
  );
  return Result.ok(null);
}

async function replaceTriggers(
  organizationId: string,
  workflowId: string,
  triggers: PersistableTrigger[]
): Promise<void> {
  const keptIds = triggers.flatMap((trigger) =>
    trigger.id ? [trigger.id] : []
  );
  await withDb(async (db) => {
    await db.workflowTrigger.deleteMany({
      where: { workflowId, id: { notIn: keptIds } },
    });
    for (const { id, ...data } of triggers) {
      if (id) {
        await db.workflowTrigger.updateMany({
          where: { id, workflowId },
          data,
        });
      } else {
        await db.workflowTrigger.create({
          data: { ...data, organizationId, workflowId },
          select: { id: true },
        });
      }
    }
  });
}

async function replaceActions(
  organizationId: string,
  workflowId: string,
  actions: PersistableAction[]
): Promise<void> {
  const keptIds = actions.flatMap((action) => (action.id ? [action.id] : []));
  await withDb(async (db) => {
    await db.workflowAction.deleteMany({
      where: { workflowId, id: { notIn: keptIds } },
    });
    for (const { id, ...data } of actions) {
      if (id) {
        await db.workflowAction.updateMany({ where: { id, workflowId }, data });
      } else {
        await db.workflowAction.create({
          data: { ...data, organizationId, workflowId },
          select: { id: true },
        });
      }
    }
  });
}

/** Mutations are admin-only, so their response shows config in full. */
async function loadSaved(
  organizationId: string,
  workflowId: string
): Promise<Result<Workflow, WorkflowServiceError>> {
  const workflow = await workflowService.get(
    organizationId,
    workflowId,
    ADMIN_VIEWER
  );
  return workflow ? Result.ok(workflow) : notFound();
}

/**
 * Turning a workflow on: the stored workflow must pass the same checks as a
 * save by this caller (run-as user, project, compute target, connections,
 * types and configs).
 */
async function validateStoredWorkflow(
  organizationId: string,
  callerId: string,
  record: WorkflowRecord
): Promise<Result<null, string>> {
  if (!record.runAsUserId) {
    return Result.err(
      "The workflow has no run-as user. Edit the workflow and choose one."
    );
  }
  if (!record.projectId) {
    return Result.err("Project not found in this organization.");
  }
  const agent = readAgentConfig(record.agentConfig);
  if (!agent) {
    return Result.err(
      "The workflow's agent settings are invalid. Edit and save the workflow."
    );
  }
  const input = saveWorkflowInputSchema.safeParse({
    ...toStoredSaveInput(record),
    projectId: record.projectId,
    runAsUserId: record.runAsUserId,
    agent,
  });
  if (!input.success) {
    return Result.err(
      `The stored workflow is incomplete (${describeIssues(input.error.issues)}). Edit and save the workflow.`
    );
  }
  const validated = await validateWorkflowInput(
    {
      organizationId,
      callerId,
      defaultRunAsUserId: record.runAsUserId,
      existing: {
        triggerIds: new Set(record.triggers.map((trigger) => trigger.id)),
        actionIds: new Set(record.actions.map((action) => action.id)),
      },
      workflowId: record.id,
    },
    input.data
  );
  return validated.ok ? Result.ok(null) : Result.err(validated.error);
}

/**
 * The stored workflow in save-input form, pre actions first and each stage
 * by position (the schema drops `position`; request order is the position).
 */
function toStoredSaveInput(record: WorkflowRecord) {
  const actions = record.actions
    .map((action) => ({
      id: action.id,
      connectionId: action.connectionId,
      type: action.type,
      config: toJsonObject(action.config),
      stage: readActionStage(action.stage),
      events: readActionEvents(action.events),
      continueOnError: action.continueOnError,
      enabled: action.enabled,
      position: action.position,
    }))
    .sort(compareActions);
  return {
    name: record.name,
    description: record.description,
    enabled: true,
    triggers: record.triggers.map((trigger) => ({
      id: trigger.id,
      connectionId: trigger.connectionId,
      type: trigger.type,
      config: toJsonObject(trigger.config),
      enabled: trigger.enabled,
    })),
    actions,
  };
}

async function loadRunCounts(
  organizationId: string,
  workflowIds: string[]
): Promise<RunCountsByWorkflow> {
  const counts: RunCountsByWorkflow = new Map();
  if (workflowIds.length === 0) {
    return counts;
  }
  const groups = await withDb((db) =>
    db.workflowRun.groupBy({
      by: ["workflowId", "status"],
      where: { organizationId, workflowId: { in: workflowIds } },
      _count: { _all: true },
    })
  );
  for (const group of groups) {
    const current = counts.get(group.workflowId) ?? emptyRunCounts();
    counts.set(group.workflowId, addRunCount(current, group));
  }
  return counts;
}

function addRunCount(
  counts: Workflow["runCounts"],
  group: { status: string; _count: { _all: number } }
): Workflow["runCounts"] {
  const amount = group._count._all;
  const isActive = WORKFLOW_RUN_ACTIVE_STATUSES.some(
    (status) => status === group.status
  );
  return {
    total: counts.total + amount,
    active: counts.active + (isActive ? amount : 0),
    succeeded:
      counts.succeeded +
      (group.status === WorkflowRunStatus.Succeeded ? amount : 0),
    failed:
      counts.failed + (group.status === WorkflowRunStatus.Failed ? amount : 0),
  };
}

function emptyRunCounts(): Workflow["runCounts"] {
  return { total: 0, active: 0, succeeded: 0, failed: 0 };
}

function toWorkflowDto(
  record: WorkflowRecord,
  counts: RunCountsByWorkflow,
  viewer: ConfigViewer
): Workflow {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    enabled: record.enabled,
    project: record.project
      ? { id: record.project.id, name: record.project.name }
      : null,
    runAsUser: record.runAsUser
      ? {
          id: record.runAsUser.id,
          name: displayUserName(record.runAsUser),
          email: record.runAsUser.email,
        }
      : null,
    agent: readAgentConfig(record.agentConfig) ?? FALLBACK_AGENT_CONFIG,
    httpEndpointConnectionId: record.managedConnection?.id ?? null,
    triggers: record.triggers.map(
      (trigger): WorkflowTrigger => ({
        id: trigger.id,
        connectionId: trigger.connectionId,
        builtInHttp: trigger.connectionId === record.managedConnection?.id,
        type: trigger.type,
        config: redactUrlFields(
          toJsonObject(trigger.config),
          findTriggerFields(trigger.type),
          viewer
        ),
        enabled: trigger.enabled,
        position: trigger.position,
      })
    ),
    actions: record.actions
      .map(
        (action): WorkflowAction => ({
          id: action.id,
          connectionId: action.connectionId,
          builtInHttp: action.connectionId === record.managedConnection?.id,
          type: action.type,
          config: redactUrlFields(
            toJsonObject(action.config),
            findActionFields(action.type),
            viewer
          ),
          stage: readActionStage(action.stage),
          events: readActionEvents(action.events),
          continueOnError: action.continueOnError,
          enabled: action.enabled,
          position: action.position,
        })
      )
      .sort(compareActions),
    runCounts: counts.get(record.id) ?? emptyRunCounts(),
    lastRunAt: record.lastRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Config fields of a trigger type (keys are unique across providers). */
function findTriggerFields(type: string): IntegrationFieldDescriptor[] | null {
  for (const provider of listIntegrationProviders()) {
    const trigger = provider.triggers.find((entry) => entry.key === type);
    if (trigger) {
      return trigger.configFields;
    }
  }
  return null;
}

/** Config fields of an action type (keys are unique across providers). */
function findActionFields(type: string): IntegrationFieldDescriptor[] | null {
  for (const provider of listIntegrationProviders()) {
    const action = provider.actions.find((entry) => entry.key === type);
    if (action) {
      return action.configFields;
    }
  }
  return null;
}

/** Pre actions first (they run first), then post; each stage by position. */
function compareActions(
  left: Pick<WorkflowAction, "stage" | "position">,
  right: Pick<WorkflowAction, "stage" | "position">
): number {
  if (left.stage !== right.stage) {
    return left.stage === WorkflowActionStage.Pre ? -1 : 1;
  }
  return left.position - right.position;
}

function badRequest<T>(message: string): Result<T, WorkflowServiceError> {
  return Result.err({ status: Status.BadRequest, message });
}

function notFound<T>(): Result<T, WorkflowServiceError> {
  return Result.err({ status: Status.NotFound, message: "Workflow not found" });
}
