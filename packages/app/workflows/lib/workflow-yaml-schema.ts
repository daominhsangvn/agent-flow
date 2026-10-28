import { connectionGrantsSchema } from "@repo/api/src/types/connection-grants";
import type { IntegrationProviderSummary } from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import {
  WORKFLOW_ACTIONS_MAX,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_DESCRIPTION_MAX,
  WORKFLOW_INSTRUCTION_MAX,
  WORKFLOW_INSTRUCTIONS_MAX,
  WORKFLOW_NAME_MAX,
  WORKFLOW_POST_ACTION_EVENTS,
  WORKFLOW_PRD_INSTRUCTION_MAX,
  WORKFLOW_TRIGGERS_MAX,
  type WorkflowPrdRule,
  WorkflowRunEvent,
  workflowAgentModeSchema,
  workflowOrchestratorConfigSchema,
  workflowRunEventSchema,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import {
  WORKFLOW_RUNNER_CONDITION_MAX,
  WORKFLOW_RUNNER_RULES_MAX,
} from "@repo/api/src/types/workflow-runner-rules";
import { z } from "zod";
import type { WorkflowComputeTargetOption } from "./workflow-editor-options";
import { WORKFLOW_RUN_EVENT_ORDER } from "./workflow-labels";

/**
 * The vocabulary of a workflow written as YAML (see workflow-yaml.ts): the
 * keys of each mapping, the lists, what `connection: http` means, what the
 * names refer to, and the shape the parsed document must have before its
 * names are resolved. Actions are one list, `actions`, each item running
 * `on` run events; the older `preActions` / `postActions` lists still read.
 */

/** What the YAML refers to by name (connections by their key, per project). */
export type WorkflowYamlCatalog = {
  providers: readonly IntegrationProviderSummary[];
  /** Every project connection of the organization. */
  projectConnections: readonly ProjectConnection[];
  projects: readonly WorkflowYamlProject[];
  users: readonly WorkflowYamlUser[];
  runners: readonly WorkflowComputeTargetOption[];
};

export type WorkflowYamlProject = { id: string; name: string };

export type WorkflowYamlUser = { id: string; name: string; email: string };

/** `connection: http`: the workflow's own HTTP endpoint, or its built-in HTTPS call. */
export const BUILT_IN_HTTP_REFERENCE = "http";

/** The action type of the built-in HTTPS call (`connection: http`). */
export const BUILT_IN_HTTPS_CALL_TYPE = "webhook.post";

/** Keys of each kind of mapping, in the order generated YAML writes them. */
export const WORKFLOW_YAML_KEYS = {
  workflow: [
    "name",
    "description",
    "enabled",
    "project",
    "triggers",
    "agent",
    "actions",
    "preActions",
    "postActions",
  ],
  trigger: ["project", "connection", "type", "enabled", "config"],
  action: [
    "on",
    "connection",
    "instruction",
    "connections",
    "type",
    "continueOnError",
    "enabled",
    "config",
  ],
  preAction: ["connection", "type", "continueOnError", "enabled", "config"],
  postAction: ["connection", "type", "events", "enabled", "config"],
  agent: [
    "project",
    "runAs",
    "runner",
    "runners",
    "mode",
    "stopOnOpenQuestions",
    "repository",
    "prd",
    "titleTemplate",
    "instructions",
    "orchestrator",
    "process",
  ],
  repository: ["fullName", "branch"],
  prd: ["instruction"],
  /** `agent.orchestrator`, orchestrated mode only. */
  orchestrator: [
    "concurrency",
    "debounceSeconds",
    "turnTimeoutMinutes",
    "cancelOn",
  ],
  /** An item of `agent.runners`. */
  runnerRule: ["runner", "condition"],
} as const;

/** The lists of the YAML, each with the item keys it takes. */
export const WorkflowYamlList = {
  Triggers: "triggers",
  Actions: "actions",
  /** The older form of `actions` with `on: workflow.triggered`. */
  PreActions: "preActions",
  /** The older form of `actions` with `on:` other events. */
  PostActions: "postActions",
} as const;

export type WorkflowYamlList =
  (typeof WorkflowYamlList)[keyof typeof WorkflowYamlList];

/**
 * The events a post action may subscribe to, de-duplicated and in lifecycle
 * order. workflow.triggered is dropped: it belongs to pre actions.
 */
export function getPostActionEvents(
  events: readonly WorkflowRunEvent[]
): WorkflowRunEvent[] {
  return WORKFLOW_RUN_EVENT_ORDER.filter(
    (event) => events.includes(event) && isPostActionEvent(event)
  );
}

function requiredText(message: string, max: number) {
  return z
    .string({
      error: (issue) => (issue.input === undefined ? message : "Write text"),
    })
    .trim()
    .min(1, message)
    .max(max);
}

/** `config:` left empty parses as null: no options. */
const configSchema = z
  .record(z.string(), z.unknown(), {
    error: "Write the options as a mapping of option: value",
  })
  .nullish()
  .transform((config) => config ?? {});

const connectionSchema = requiredText(
  `Name the connection by its key (${BUILT_IN_HTTP_REFERENCE} for the workflow's own URL or HTTPS call)`,
  200
);

const triggerYamlSchema = z.object({
  /** The trigger's own project; omitted: the workflow's `project`. */
  project: z.string().trim().min(1).max(200).nullish(),
  connection: connectionSchema,
  type: requiredText("Name the trigger type, e.g. jira.issue_assigned", 64),
  enabled: z.boolean().default(true),
  config: configSchema,
});

const preActionYamlSchema = z.object({
  connection: connectionSchema,
  type: requiredText("Name the action type, e.g. jira.add_comment", 64),
  continueOnError: z.boolean().default(false),
  enabled: z.boolean().default(true),
  config: configSchema,
});

const postActionYamlSchema = z.object({
  connection: connectionSchema,
  type: requiredText("Name the action type, e.g. jira.add_comment", 64),
  events: z
    .array(
      workflowRunEventSchema.refine(isPostActionEvent, {
        message: `${WorkflowRunEvent.Triggered} is for pre actions: list a later event`,
      }),
      {
        error: `List the run events, e.g. [${WorkflowRunEvent.Succeeded}, ${WorkflowRunEvent.Failed}]`,
      }
    )
    .min(1, "List at least one run event"),
  enabled: z.boolean().default(true),
  config: configSchema,
});

const EVENT_LIST_ERROR = `Write the run event, or a list of them, e.g. ${WorkflowRunEvent.ExecuteCompleted} or [${WorkflowRunEvent.Succeeded}, ${WorkflowRunEvent.Failed}]`;

/** `on:` one run event or a list; workflow.triggered stands alone. */
const onSchema = z
  .union([workflowRunEventSchema, z.array(workflowRunEventSchema)], {
    error: EVENT_LIST_ERROR,
  })
  .transform((on) => (Array.isArray(on) ? [...new Set(on)] : [on]))
  .refine((events) => events.length > 0, "List at least one run event")
  .refine(
    (events) =>
      !events.includes(WorkflowRunEvent.Triggered) || events.length === 1,
    `${WorkflowRunEvent.Triggered} runs before the agent team: give it its own action`
  );

/**
 * An item of `actions`: `on` plus either an `instruction` (an agent decides
 * what to do on the connection) or a `type` with its `config`. Without
 * `connection` the run chooses: the source connection for an instruction,
 * the source or project repository connection that offers the type.
 */
const actionYamlSchema = z
  .object({
    on: onSchema,
    connection: z.string().trim().min(1).max(200).nullish(),
    instruction: z
      .string({ error: "Write the instruction as text" })
      .trim()
      .min(1, "Write the instruction")
      .max(WORKFLOW_INSTRUCTION_MAX)
      .nullish(),
    /** What an instruction's agent may write (connection-grants.ts). */
    connections: connectionGrantsSchema.nullish(),
    type: z.string().trim().min(1).max(64).nullish(),
    continueOnError: z.boolean().default(false),
    enabled: z.boolean().default(true),
    config: configSchema,
  })
  .superRefine((action, ctx) => {
    if (Boolean(action.instruction) === Boolean(action.type)) {
      ctx.addIssue({
        code: "custom",
        path: action.type ? ["type"] : ["on"],
        message:
          "Give the action an instruction, or a type with its config (not both)",
      });
    }
    if (action.connections && !action.instruction) {
      ctx.addIssue({
        code: "custom",
        path: ["connections"],
        message:
          "connections: grants what an instruction's agent may write; a typed action names its connection",
      });
    }
    if (action.instruction && action.connection) {
      ctx.addIssue({
        code: "custom",
        path: ["connection"],
        message:
          "An instruction works on the run's source item: list other connections under connections:",
      });
    }
    if (action.instruction && Object.keys(action.config).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["config"],
        message: "An instruction has no config: write what to do in it",
      });
    }
    if (
      action.continueOnError &&
      !action.on.includes(WorkflowRunEvent.Triggered)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["continueOnError"],
        message: `continueOnError applies to ${WorkflowRunEvent.Triggered} actions only`,
      });
    }
  });

/**
 * `agent.prd`: the instruction the run's computer classifies the item by.
 * Left out, or without an instruction: every item is an Issue.
 */
const prdYamlSchema = z
  .object(
    {
      instruction: z
        .string({ error: "Write the instruction as text" })
        .trim()
        .max(
          WORKFLOW_PRD_INSTRUCTION_MAX,
          `Keep the instruction under ${WORKFLOW_PRD_INSTRUCTION_MAX} characters`
        )
        .nullish(),
    },
    { error: "Write the PRD rule as a mapping with instruction:" }
  )
  .nullish()
  .transform(
    (prd): WorkflowPrdRule => ({ instruction: prd?.instruction || null })
  );

const agentYamlSchema = z.object(
  {
    /** The older place of the workflow's `project`; still read. */
    project: z.string().trim().min(1).max(200).nullish(),
    runAs: z.string().trim().min(1).nullish(),
    runner: requiredText("Name the runner the loops run on", 200),
    runners: z
      .array(
        z.object({
          runner: requiredText("Name the runner of the rule", 200),
          condition: requiredText(
            'Write when the rule applies, e.g. source.assignee_email == "an@acme.dev"',
            WORKFLOW_RUNNER_CONDITION_MAX
          ),
        }),
        { error: "Write runners: as a list of runner and condition" }
      )
      .max(WORKFLOW_RUNNER_RULES_MAX)
      .nullish()
      .transform((rules) => rules ?? []),
    mode: workflowAgentModeSchema.default(WorkflowAgentMode.PlanAndExecute),
    stopOnOpenQuestions: z.boolean().default(true),
    repository: z
      .object({
        fullName: requiredText("Write the repository, e.g. acme/web", 200).min(
          3,
          "Write the repository, e.g. acme/web"
        ),
        branch: requiredText("Write the base branch, e.g. main", 200),
      })
      .nullish(),
    prd: prdYamlSchema,
    titleTemplate: z
      .string()
      .trim()
      .min(1, "Write the title template")
      .max(300)
      .default(WORKFLOW_DEFAULT_TITLE_TEMPLATE),
    instructions: z.string().max(WORKFLOW_INSTRUCTIONS_MAX).nullish(),
    orchestrator: workflowOrchestratorConfigSchema.nullish(),
    // Checked by the project process schema (`checkProcess`).
    process: z.unknown().optional(),
  },
  { error: "Add the agent: mapping (runner, mode, …)" }
);

export const workflowYamlSchema = z
  .object({
    name: requiredText("Name the workflow", WORKFLOW_NAME_MAX),
    description: z.string().max(WORKFLOW_DESCRIPTION_MAX).nullish(),
    enabled: z.boolean().default(true),
    /** The project of the workflow's runs; a trigger may name its own. Empty: not chosen yet. */
    project: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((project) => project || null),
    triggers: z
      .array(triggerYamlSchema, { error: "Add the triggers: list" })
      .min(1, "Add at least one trigger")
      .max(WORKFLOW_TRIGGERS_MAX),
    agent: agentYamlSchema,
    actions: z
      .array(actionYamlSchema, {
        error: "List the actions, each with on: and an instruction or a type",
      })
      .nullish(),
    preActions: z.array(preActionYamlSchema).nullish(),
    postActions: z.array(postActionYamlSchema).nullish(),
  })
  .superRefine((workflow, ctx) => {
    if (!(workflow.project || workflow.agent.project)) {
      ctx.addIssue({
        code: "custom",
        path: ["project"],
        message: "Name the project the workflow's runs belong to (project:)",
      });
    }
    const count =
      (workflow.actions?.length ?? 0) +
      (workflow.preActions?.length ?? 0) +
      (workflow.postActions?.length ?? 0);
    if (count > WORKFLOW_ACTIONS_MAX) {
      ctx.addIssue({
        code: "custom",
        path: [WorkflowYamlList.Actions],
        message: `A workflow has at most ${WORKFLOW_ACTIONS_MAX} actions`,
      });
    }
  });

export type WorkflowYaml = z.infer<typeof workflowYamlSchema>;

export type TriggerYaml = z.infer<typeof triggerYamlSchema>;

export type ActionYaml = z.infer<typeof actionYamlSchema>;

export type PreActionYaml = z.infer<typeof preActionYamlSchema>;

export type PostActionYaml = z.infer<typeof postActionYamlSchema>;

function isPostActionEvent(event: WorkflowRunEvent): boolean {
  return WORKFLOW_POST_ACTION_EVENTS.includes(event);
}
