import type {
  IntegrationActionSummary,
  IntegrationFieldDescriptor,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  type ProjectProcessInput,
  projectProcessSchema,
} from "@repo/api/src/types/project-process";
import {
  type SaveWorkflowInput,
  WORKFLOW_ACTIONS_MAX,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_DESCRIPTION_MAX,
  WORKFLOW_INSTRUCTIONS_MAX,
  WORKFLOW_NAME_MAX,
  WORKFLOW_POST_ACTION_EVENTS,
  WORKFLOW_TRIGGERS_MAX,
  type Workflow,
  type WorkflowAction,
  type WorkflowActionInput,
  WorkflowActionStage,
  type WorkflowRunEvent,
  type WorkflowTriggerInput,
  workflowAgentModeSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
// Cross-slice: workflow trigger/action configs are rendered and validated by
// the integrations slice's descriptor-driven field model.
import {
  collectFieldValues,
  hasFieldErrors,
  type IntegrationFieldErrors,
  validateFieldValues,
} from "@repo/app/integrations/lib/integration-field-values";
// Cross-slice: a workflow's own process uses the project process draft rules.
import { validateProcessDraft } from "@repo/app/projects/lib/process-draft";
import { z } from "zod";
import {
  BUILT_IN_HTTP_CONNECTION,
  findActionDefinition,
  findTriggerDefinition,
} from "./workflow-catalog";
import { WORKFLOW_RUN_EVENT_ORDER } from "./workflow-labels";

/**
 * Form model of the workflow editor. The top-level fields are validated by
 * `workflowFormSchema` (react-hook-form + standardSchemaResolver); the dynamic
 * trigger/action config maps are validated against the provider descriptors
 * by `validateWorkflowConfigs`, because their shape is only known at runtime.
 * `toSaveWorkflowInput` maps the form to the `SaveWorkflowInput` wire shape.
 *
 * Actions are edited as two lists that follow the flow trigger -> pre actions
 * -> agent team -> post actions: `preActions` run in order before the agent
 * team (no events; a failure stops the run unless `continueOnError`) and
 * `postActions` run on the run events they subscribe to. On the wire they are
 * one `actions` array: pre actions first, then post actions, each list in its
 * editor order (the server derives positions from that order).
 */

/** Select value meaning "run as the admin who saves the workflow" (no `runAsUserId`). */
export const RUN_AS_SAVER = "__saver__";

export const WORKFLOW_FORM_MESSAGES = {
  nameRequired: "Name is required",
  projectRequired: "Choose the project for imported issues",
  computeTargetRequired: "Choose a compute target",
  connectionRequired: "Choose a connection",
  triggerTypeRequired: "Choose a trigger",
  actionTypeRequired: "Choose an action",
  eventsRequired: "Choose at least one event",
  triggeredEventReserved:
    "Trigger received is for pre actions; choose a later event for a post action",
  actionsMax: `A workflow can have at most ${WORKFLOW_ACTIONS_MAX} pre and post actions in total`,
  triggersRequired: "Add at least one trigger",
  titleTemplateRequired: "Title template is required",
  repositoryRequired: "Enter the repository, e.g. acme/web",
  branchRequired: "Enter a branch",
} as const;

/** The two action lists of the form, in flow order. */
export const WorkflowActionList = {
  Pre: "preActions",
  Post: "postActions",
} as const;
export type WorkflowActionList =
  (typeof WorkflowActionList)[keyof typeof WorkflowActionList];

export const workflowTriggerDraftSchema = z.object({
  /** Server id of an existing trigger (kept so its run history stays linked). */
  serverId: z.string().optional(),
  connectionId: z
    .string()
    .min(1, { message: WORKFLOW_FORM_MESSAGES.connectionRequired }),
  type: z
    .string()
    .min(1, { message: WORKFLOW_FORM_MESSAGES.triggerTypeRequired }),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});
export type WorkflowTriggerDraft = z.infer<typeof workflowTriggerDraftSchema>;

/** A pre action: runs right after a trigger fires, before the agent team, in list order. */
export const workflowPreActionDraftSchema = z.object({
  /** Server id of an existing action (kept so its action runs stay linked). */
  serverId: z.string().optional(),
  connectionId: z
    .string()
    .min(1, { message: WORKFLOW_FORM_MESSAGES.connectionRequired }),
  type: z
    .string()
    .min(1, { message: WORKFLOW_FORM_MESSAGES.actionTypeRequired }),
  config: z.record(z.string(), z.unknown()),
  /** Keep going to the agent team when this action fails. */
  continueOnError: z.boolean(),
  enabled: z.boolean(),
});
export type WorkflowPreActionDraft = z.infer<
  typeof workflowPreActionDraftSchema
>;

/** A post action: runs when the run reaches one of its events. */
export const workflowPostActionDraftSchema = workflowPreActionDraftSchema
  .omit({ continueOnError: true })
  .extend({
    events: z
      .array(
        workflowRunEventSchema.refine(isPostActionEvent, {
          message: WORKFLOW_FORM_MESSAGES.triggeredEventReserved,
        })
      )
      .min(1, { message: WORKFLOW_FORM_MESSAGES.eventsRequired }),
  });
export type WorkflowPostActionDraft = z.infer<
  typeof workflowPostActionDraftSchema
>;

/** The fields every action row edits, whatever its list. */
export type WorkflowActionDraftBase = Pick<
  WorkflowPreActionDraft,
  "serverId" | "connectionId" | "type" | "config" | "enabled"
>;

export const workflowFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: WORKFLOW_FORM_MESSAGES.nameRequired })
      .max(WORKFLOW_NAME_MAX),
    description: z.string().max(WORKFLOW_DESCRIPTION_MAX),
    enabled: z.boolean(),
    projectId: z
      .string()
      .min(1, { message: WORKFLOW_FORM_MESSAGES.projectRequired }),
    runAsUserId: z.string(),
    mode: workflowAgentModeSchema,
    stopOnOpenQuestions: z.boolean(),
    computeTargetId: z
      .string()
      .min(1, { message: WORKFLOW_FORM_MESSAGES.computeTargetRequired }),
    overrideRepository: z.boolean(),
    repositoryFullName: z.string().max(200),
    repositoryBranch: z.string().max(200),
    instructions: z.string().max(WORKFLOW_INSTRUCTIONS_MAX),
    titleTemplate: z
      .string()
      .trim()
      .min(1, { message: WORKFLOW_FORM_MESSAGES.titleTemplateRequired })
      .max(300),
    triggers: z
      .array(workflowTriggerDraftSchema)
      .min(1, { message: WORKFLOW_FORM_MESSAGES.triggersRequired })
      .max(WORKFLOW_TRIGGERS_MAX),
    preActions: z.array(workflowPreActionDraftSchema),
    postActions: z.array(workflowPostActionDraftSchema),
    /** The workflow's own process; null: the project's process. */
    ownProcess: z.custom<ProjectProcessInput>().nullable(),
  })
  .superRefine((values, ctx) => {
    refineRepository(values, ctx);
    refineActionCount(values, ctx);
    refineOwnProcess(values, ctx);
  });
export type WorkflowFormValues = z.infer<typeof workflowFormSchema>;

/** Descriptor-validation errors of the dynamic configs, keyed by row index. */
export type WorkflowConfigErrors = {
  triggers: Record<number, IntegrationFieldErrors>;
  preActions: Record<number, IntegrationFieldErrors>;
  postActions: Record<number, IntegrationFieldErrors>;
};

export const EMPTY_WORKFLOW_CONFIG_ERRORS: WorkflowConfigErrors = {
  triggers: {},
  preActions: {},
  postActions: {},
};

export function createTriggerDraft(connectionId = ""): WorkflowTriggerDraft {
  return { connectionId, type: "", config: {}, enabled: true };
}

export function createPreActionDraft(
  connectionId = ""
): WorkflowPreActionDraft {
  return {
    connectionId,
    type: "",
    config: {},
    continueOnError: false,
    enabled: true,
  };
}

export function createPostActionDraft(
  connectionId = ""
): WorkflowPostActionDraft {
  return { connectionId, type: "", config: {}, events: [], enabled: true };
}

/** Pre and post actions together; both lists share `WORKFLOW_ACTIONS_MAX`. */
export function countWorkflowActions(
  values: Pick<WorkflowFormValues, "preActions" | "postActions">
): number {
  return values.preActions.length + values.postActions.length;
}

/** Form values for a new workflow: plan and implement, one empty trigger row. */
export function createEmptyWorkflowFormValues(): WorkflowFormValues {
  return {
    name: "",
    description: "",
    enabled: true,
    projectId: "",
    runAsUserId: RUN_AS_SAVER,
    mode: WorkflowAgentMode.PlanAndExecute,
    stopOnOpenQuestions: true,
    computeTargetId: "",
    overrideRepository: false,
    repositoryFullName: "",
    repositoryBranch: "",
    instructions: "",
    titleTemplate: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
    triggers: [createTriggerDraft()],
    preActions: [],
    postActions: [],
    ownProcess: null,
  };
}

/** Form values for an existing workflow, triggers and actions in saved order. */
export function workflowToFormValues(workflow: Workflow): WorkflowFormValues {
  const repository = workflow.agent.repository;
  const actions = splitActionsByStage(workflow.actions);
  return {
    name: workflow.name,
    description: workflow.description,
    enabled: workflow.enabled,
    projectId: workflow.project?.id ?? "",
    runAsUserId: workflow.runAsUser?.id ?? RUN_AS_SAVER,
    mode: workflow.agent.mode,
    stopOnOpenQuestions: workflow.agent.stopOnOpenQuestions,
    computeTargetId: workflow.agent.computeTargetId,
    overrideRepository: repository !== null,
    repositoryFullName: repository?.fullName ?? "",
    repositoryBranch: repository?.branch ?? "",
    instructions: workflow.agent.instructions,
    titleTemplate: workflow.agent.titleTemplate,
    triggers: [...workflow.triggers]
      .sort((a, b) => a.position - b.position)
      .map((trigger) => ({
        serverId: trigger.id,
        connectionId: trigger.builtInHttp
          ? BUILT_IN_HTTP_CONNECTION
          : trigger.connectionId,
        type: trigger.type,
        config: { ...trigger.config },
        enabled: trigger.enabled,
      })),
    preActions: actions.pre.map((action) => ({
      ...toActionDraftBase(action),
      continueOnError: action.continueOnError,
    })),
    postActions: actions.post.map((action) => ({
      ...toActionDraftBase(action),
      events: getPostActionEvents(action.events),
    })),
    ownProcess: workflow.agent.process ?? null,
  };
}

/**
 * Validates every trigger and action config against its descriptor. Rows
 * whose type is unknown to the catalog are left to the server.
 */
export function validateWorkflowConfigs(
  values: Pick<WorkflowFormValues, "triggers" | "preActions" | "postActions">,
  providers: readonly IntegrationProviderSummary[]
): WorkflowConfigErrors {
  const findAction = (type: string) => findActionDefinition(providers, type);
  return {
    triggers: validateRowConfigs(values.triggers, (type) =>
      findTriggerDefinition(providers, type)
    ),
    preActions: validateRowConfigs(values.preActions, findAction),
    postActions: validateRowConfigs(values.postActions, findAction),
  };
}

export function hasWorkflowConfigErrors(errors: WorkflowConfigErrors): boolean {
  return (
    Object.keys(errors.triggers).length > 0 ||
    Object.keys(errors.preActions).length > 0 ||
    Object.keys(errors.postActions).length > 0
  );
}

/** Maps validated form values to the `POST /workflows` / `PUT /workflows/{id}` body. */
export function toSaveWorkflowInput(
  values: WorkflowFormValues,
  providers: readonly IntegrationProviderSummary[]
): SaveWorkflowInput {
  const input: SaveWorkflowInput = {
    name: values.name.trim(),
    description: values.description,
    enabled: values.enabled,
    projectId: values.projectId,
    agent: {
      mode: values.mode,
      stopOnOpenQuestions: values.stopOnOpenQuestions,
      computeTargetId: values.computeTargetId,
      repository: values.overrideRepository
        ? {
            fullName: values.repositoryFullName.trim(),
            branch: values.repositoryBranch.trim(),
          }
        : null,
      instructions: values.instructions,
      titleTemplate: values.titleTemplate.trim(),
      process: values.ownProcess
        ? projectProcessSchema.parse(values.ownProcess)
        : null,
    },
    triggers: values.triggers.map((trigger) =>
      toTriggerInput(trigger, providers)
    ),
    actions: [
      ...values.preActions.map((action) => toPreActionInput(action, providers)),
      ...values.postActions.map((action) =>
        toPostActionInput(action, providers)
      ),
    ],
  };
  if (values.runAsUserId && values.runAsUserId !== RUN_AS_SAVER) {
    input.runAsUserId = values.runAsUserId;
  }
  return input;
}

/**
 * Events a new post action of this type starts with: the definition's default
 * subscription, restricted to known post action events.
 */
export function getDefaultActionEvents(
  defaultEvents: readonly string[]
): WorkflowRunEvent[] {
  const events: WorkflowRunEvent[] = [];
  for (const event of defaultEvents) {
    const parsed = workflowRunEventSchema.safeParse(event);
    if (parsed.success) {
      events.push(parsed.data);
    }
  }
  return getPostActionEvents(events);
}

/** The default post action events of an action definition (none when it is unknown). */
export function getDefinitionDefaultEvents(
  definition: Pick<IntegrationActionSummary, "defaultEvents"> | undefined
): WorkflowRunEvent[] {
  return getDefaultActionEvents(definition?.defaultEvents ?? []);
}

/** De-duplicates events and puts them in lifecycle order. */
export function sortRunEvents(
  events: readonly WorkflowRunEvent[]
): WorkflowRunEvent[] {
  return WORKFLOW_RUN_EVENT_ORDER.filter((event) => events.includes(event));
}

/**
 * The events a post action may subscribe to, de-duplicated and in lifecycle
 * order. run.triggered is dropped: it belongs to pre actions.
 */
export function getPostActionEvents(
  events: readonly WorkflowRunEvent[]
): WorkflowRunEvent[] {
  return sortRunEvents(events).filter(isPostActionEvent);
}

const REPOSITORY_NAME_MIN = 3;

function isPostActionEvent(event: WorkflowRunEvent): boolean {
  return WORKFLOW_POST_ACTION_EVENTS.includes(event);
}

function refineRepository(
  values: Pick<
    WorkflowFormValues,
    "overrideRepository" | "repositoryFullName" | "repositoryBranch"
  >,
  ctx: z.RefinementCtx
) {
  if (!values.overrideRepository) {
    return;
  }
  if (values.repositoryFullName.trim().length < REPOSITORY_NAME_MIN) {
    ctx.addIssue({
      code: "custom",
      path: ["repositoryFullName"],
      message: WORKFLOW_FORM_MESSAGES.repositoryRequired,
    });
  }
  if (values.repositoryBranch.trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["repositoryBranch"],
      message: WORKFLOW_FORM_MESSAGES.branchRequired,
    });
  }
}

function refineActionCount(
  values: Pick<WorkflowFormValues, "preActions" | "postActions">,
  ctx: z.RefinementCtx
) {
  if (countWorkflowActions(values) > WORKFLOW_ACTIONS_MAX) {
    ctx.addIssue({
      code: "custom",
      path: [WorkflowActionList.Post],
      message: WORKFLOW_FORM_MESSAGES.actionsMax,
    });
  }
}

function validateRowConfigs(
  rows: readonly Pick<WorkflowActionDraftBase, "type" | "config">[],
  findDefinition: (
    type: string
  ) => { configFields: IntegrationFieldDescriptor[] } | undefined
): Record<number, IntegrationFieldErrors> {
  const errors: Record<number, IntegrationFieldErrors> = {};
  rows.forEach((row, index) => {
    const definition = findDefinition(row.type);
    const rowErrors = definition
      ? validateFieldValues(definition.configFields, row.config)
      : {};
    if (hasFieldErrors(rowErrors)) {
      errors[index] = rowErrors;
    }
  });
  return errors;
}

function toTriggerInput(
  trigger: WorkflowTriggerDraft,
  providers: readonly IntegrationProviderSummary[]
): WorkflowTriggerInput {
  const definition = findTriggerDefinition(providers, trigger.type);
  const input: WorkflowTriggerInput = {
    connectionId:
      trigger.connectionId === BUILT_IN_HTTP_CONNECTION
        ? null
        : trigger.connectionId,
    type: trigger.type,
    config: definition
      ? collectFieldValues(definition.configFields, trigger.config).config
      : keepUnknownConfig(trigger.config),
    enabled: trigger.enabled,
  };
  if (trigger.serverId) {
    input.id = trigger.serverId;
  }
  return input;
}

function toPreActionInput(
  action: WorkflowPreActionDraft,
  providers: readonly IntegrationProviderSummary[]
): WorkflowActionInput {
  return toActionInput(action, providers, {
    stage: WorkflowActionStage.Pre,
    events: [],
    continueOnError: action.continueOnError,
  });
}

function toPostActionInput(
  action: WorkflowPostActionDraft,
  providers: readonly IntegrationProviderSummary[]
): WorkflowActionInput {
  return toActionInput(action, providers, {
    stage: WorkflowActionStage.Post,
    events: getPostActionEvents(action.events),
    continueOnError: false,
  });
}

function toActionInput(
  action: WorkflowActionDraftBase,
  providers: readonly IntegrationProviderSummary[],
  stageFields: Pick<WorkflowActionInput, "stage" | "events" | "continueOnError">
): WorkflowActionInput {
  const definition = findActionDefinition(providers, action.type);
  const input: WorkflowActionInput = {
    connectionId:
      action.connectionId === BUILT_IN_HTTP_CONNECTION
        ? null
        : action.connectionId,
    type: action.type,
    config: definition
      ? collectFieldValues(definition.configFields, action.config).config
      : keepUnknownConfig(action.config),
    ...stageFields,
    enabled: action.enabled,
  };
  if (action.serverId) {
    input.id = action.serverId;
  }
  return input;
}

/**
 * Keeps a config the catalog cannot describe (its provider was removed) as it
 * was loaded, so saving an unrelated change does not silently drop it. The
 * server re-validates it; the editor shows its message on a failed save.
 */
function keepUnknownConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  return { ...config };
}

function toActionDraftBase(action: WorkflowAction): WorkflowActionDraftBase {
  return {
    serverId: action.id,
    connectionId: action.builtInHttp
      ? BUILT_IN_HTTP_CONNECTION
      : action.connectionId,
    type: action.type,
    config: { ...action.config },
    enabled: action.enabled,
  };
}

/** Stored actions split by stage, each stage in position order. */
function splitActionsByStage(actions: readonly WorkflowAction[]): {
  pre: WorkflowAction[];
  post: WorkflowAction[];
} {
  const sorted = [...actions].sort((a, b) => a.position - b.position);
  return {
    pre: sorted.filter((action) => action.stage === WorkflowActionStage.Pre),
    post: sorted.filter((action) => action.stage === WorkflowActionStage.Post),
  };
}

/** A workflow's own process must be a valid process, like the project's. */
function refineOwnProcess(
  values: Pick<WorkflowFormValues, "ownProcess">,
  ctx: z.RefinementCtx
) {
  if (!values.ownProcess) {
    return;
  }
  const validation = validateProcessDraft(values.ownProcess);
  if (!validation.ok) {
    ctx.addIssue({
      code: "custom",
      path: ["ownProcess"],
      message: `The workflow's process: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    });
  }
}
