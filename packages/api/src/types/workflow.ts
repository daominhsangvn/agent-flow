import type { DocumentType } from "@agentflow-ai/loops-api/document";
import { z } from "zod";
import type { JsonObject } from "./common";
import { connectionGrantsSchema } from "./connection-grants.ts";
import type { WorkflowRunToolCall } from "./integration-tools.ts";
import {
  ORCHESTRATOR_CANCEL_ON_DEFAULT,
  ORCHESTRATOR_DEBOUNCE_SECONDS_DEFAULT,
  ORCHESTRATOR_DEBOUNCE_SECONDS_MAX,
  ORCHESTRATOR_TURN_TIMEOUT_MINUTES_DEFAULT,
  ORCHESTRATOR_TURN_TIMEOUT_MINUTES_MAX,
  OrchestratorConcurrency,
  OrchestratorTicketChange,
} from "./orchestrator.ts";
import { projectConnectionKeySchema } from "./project-connection.ts";
import {
  type ProcessDocumentType,
  projectProcessSchema,
  type RunProcessView,
} from "./project-process.ts";
import { WorkflowAgentMode } from "./workflow-agent-mode.ts";
import {
  WORKFLOW_RUNNER_RULES_MAX,
  workflowRunnerRuleSchema,
} from "./workflow-runner-rules.ts";

/**
 * Event-driven workflows: one or more triggers (Jira issue assigned to the
 * bot, Azure DevOps work item assigned, generic HTTPS request, ...) start an
 * agent-team run on a desktop compute target, and actions (comment on the
 * source item, Teams message, HTTPS callback, ...) run on run events: a typed
 * action of a provider, or an instruction an agent carries out with the
 * provider's actions. Triggers and actions are provided by integration
 * connections (see ./integration.ts); nothing here is provider-specific.
 *
 * The engine never writes to a source system on its own: every change in Jira,
 * Azure DevOps, Teams, ... is an action configured by an admin.
 *
 * Flow: trigger -> import -> workflow.triggered actions (sequential, before
 * the agent team) -> agent team (PLAN, optional EXECUTE) -> actions on the
 * later run events.
 *
 * Run lifecycle:
 *   received -> ingesting -> [pre_actions -> ingesting] -> planning -> [executing] -> succeeded
 *                                     \-> needs_input (plan has open questions;
 *                                         resumes when someone starts a PLAN or
 *                                         EXECUTE loop on the plan document)
 *   any non-final state -> failed | cancelled
 */

export const WorkflowRunStatus = {
  Received: "received",
  /** Pre actions are running, one after another, before the agent team starts. */
  PreActions: "pre_actions",
  Ingesting: "ingesting",
  Planning: "planning",
  Executing: "executing",
  /** An agent step of the project's process is running (a STEP loop). */
  Running: "running",
  NeedsInput: "needs_input",
  /** An approval step of the project's process waits for a person's decision. */
  NeedsApproval: "needs_approval",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type WorkflowRunStatus =
  (typeof WorkflowRunStatus)[keyof typeof WorkflowRunStatus];

/** Statuses after which a run never changes again. */
export const WORKFLOW_RUN_FINAL_STATUSES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.Succeeded,
  WorkflowRunStatus.Failed,
  WorkflowRunStatus.Cancelled,
];

/** Statuses that block a second run for the same source item in the same workflow. */
export const WORKFLOW_RUN_ACTIVE_STATUSES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.Received,
  WorkflowRunStatus.PreActions,
  WorkflowRunStatus.Ingesting,
  WorkflowRunStatus.Planning,
  WorkflowRunStatus.Executing,
  WorkflowRunStatus.Running,
  WorkflowRunStatus.NeedsInput,
  WorkflowRunStatus.NeedsApproval,
];

/**
 * Run events, named after the run's phases. Actions on `workflow.triggered`
 * run before the agent team (the pre stage); the others after it (post).
 */
export const WorkflowRunEvent = {
  /**
   * A trigger fired (or a needs_input run resumed) and the item was imported.
   * Its actions run before the agent team starts.
   */
  Triggered: "workflow.triggered",
  /** The agent team was launched (its first loop dispatched; cycle 1 only). */
  Started: "workflow.started",
  /** A PLAN loop was launched (or a person's PLAN was adopted): the plan is being written. */
  PlanStarted: "plan.started",
  /** The PLAN loop completed; the plan document has content. */
  PlanReady: "plan.completed",
  /**
   * The run waits for a person: the plan or a process step has open
   * questions, or a process step waits for an approval.
   */
  NeedsInput: "input.needed",
  /** The EXECUTE loop (or a process step that pushes) was launched. */
  ExecuteStarted: "execute.started",
  /** The EXECUTE loop (or a process step that pushes) completed. */
  ExecuteCompleted: "execute.completed",
  /** Plan mode: plan ready. Plan+execute mode: implementation finished. */
  Succeeded: "workflow.completed",
  Failed: "workflow.failed",
} as const;
export type WorkflowRunEvent =
  (typeof WorkflowRunEvent)[keyof typeof WorkflowRunEvent];

/**
 * The names the run events had before they were named after the run's
 * phases. Still accepted wherever an event is read, so older YAML and API
 * clients keep working.
 */
export const LEGACY_WORKFLOW_RUN_EVENTS: Readonly<
  Record<string, WorkflowRunEvent>
> = {
  "run.triggered": WorkflowRunEvent.Triggered,
  "run.started": WorkflowRunEvent.Started,
  "run.plan_ready": WorkflowRunEvent.PlanReady,
  "run.needs_input": WorkflowRunEvent.NeedsInput,
  "run.succeeded": WorkflowRunEvent.Succeeded,
  "run.failed": WorkflowRunEvent.Failed,
};

/** Events a post action may subscribe to (everything except workflow.triggered). */
export const WORKFLOW_POST_ACTION_EVENTS: readonly WorkflowRunEvent[] = [
  WorkflowRunEvent.Started,
  WorkflowRunEvent.PlanStarted,
  WorkflowRunEvent.PlanReady,
  WorkflowRunEvent.NeedsInput,
  WorkflowRunEvent.ExecuteStarted,
  WorkflowRunEvent.ExecuteCompleted,
  WorkflowRunEvent.Succeeded,
  WorkflowRunEvent.Failed,
];

/**
 * When an action runs.
 * - pre: on workflow.triggered, once the item is imported and before the
 *   agent team starts, in the configured order. A failed pre action stops the
 *   run unless continueOnError is set.
 * - post: on the run events it subscribes to. Never changes the run status.
 */
export const WorkflowActionStage = {
  Pre: "pre",
  Post: "post",
} as const;
export type WorkflowActionStage =
  (typeof WorkflowActionStage)[keyof typeof WorkflowActionStage];

/**
 * Failure codes a workflow run can end with (WorkflowRun.error.code). Every
 * engine step maps its failure to one of these instead of throwing.
 */
export const WorkflowRunErrorCode = {
  WorkflowDisabled: "workflow_disabled",
  ProjectMissing: "project_missing",
  RunAsUserMissing: "run_as_user_missing",
  AgentConfigInvalid: "agent_config_invalid",
  PreActionFailed: "pre_action_failed",
  SourceFetchFailed: "source_fetch_failed",
  DocumentCreateFailed: "document_create_failed",
  ComputeTargetUnavailable: "compute_target_unavailable",
  /**
   * A personal runner that runs one loop at a time is busy: the step waits
   * for it (retried, never fails the run by itself).
   */
  RunnerBusy: "runner_busy",
  SigningRequired: "signing_required",
  NoRepository: "no_repository",
  RepositoryNotAllowed: "repository_not_allowed",
  ConcurrencyLimit: "concurrency_limit",
  LoopAlreadyActive: "loop_already_active",
  DocumentBlocked: "document_blocked",
  DispatchFailed: "dispatch_failed",
  PlanFailed: "plan_failed",
  ExecuteFailed: "execute_failed",
  /** An agent step of the project's process failed (its STEP loop did not complete). */
  StepFailed: "step_failed",
  /** An approval step of the project's process was rejected. */
  ApprovalRejected: "approval_rejected",
  /** A person rejected a step under review (AgentFlow only). */
  ReviewRejected: "review_rejected",
  PlanStateUnavailable: "plan_state_unavailable",
  PhaseTimeout: "phase_timeout",
  Cancelled: "cancelled",
  InternalError: "internal_error",
} as const;
export type WorkflowRunErrorCode =
  (typeof WorkflowRunErrorCode)[keyof typeof WorkflowRunErrorCode];

export const WorkflowActionRunStatus = {
  Pending: "pending",
  Running: "running",
  /** An instruction action waits for its agent on the run's computer. */
  Waiting: "waiting",
  Succeeded: "succeeded",
  Failed: "failed",
  Skipped: "skipped",
} as const;
export type WorkflowActionRunStatus =
  (typeof WorkflowActionRunStatus)[keyof typeof WorkflowActionRunStatus];

// When a template variable has a value (WORKFLOW_TEMPLATE_VARIABLES `available`);
// declared first because the list below reads them.
const ALWAYS_AVAILABLE = "Every event";
const IMPORTED_AVAILABLE =
  "Once the item is imported: every event, workflow.triggered included";
const PLAN_AVAILABLE = "From plan.completed (empty before)";
const PULL_REQUEST_AVAILABLE =
  "Once a create pull request action of the run opened one: put it earlier in the list, or on an earlier event";
const REPOSITORY_AVAILABLE =
  "From execute.started (EXECUTE records the repositories)";
const STEP_AVAILABLE =
  "With a process, on every event after workflow.triggered: the step the run is in";
const STEP_OUTPUT_AVAILABLE =
  "With a process, once that step ended (not on workflow.triggered)";
const RELEASE_NOTES_AVAILABLE =
  "From execute.completed of an implement step that writes release notes";

/**
 * The `{{variables}}` of action text options, instructions and the issue
 * title template. `available` says from when the run has a value for it
 * (otherwise it renders as an empty string).
 */
export const WORKFLOW_TEMPLATE_VARIABLES = [
  {
    name: "summary",
    description: "Ready-made markdown summary for the event",
    available: "Every event, with a text of its own per event",
  },
  {
    name: "event",
    description: "Run event, e.g. workflow.triggered or execute.completed",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "run.status",
    description: "Run status",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "run.url",
    description: "Link to the run in AgentFlow",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "workflow.name",
    description: "Workflow name",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "source.provider",
    description: "Provider of the source item",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "source.key",
    description: "Source item key, e.g. PROJ-123",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "source.title",
    description: "Source item title",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "source.url",
    description: "Link to the source item",
    available: ALWAYS_AVAILABLE,
  },
  {
    name: "feature.url",
    description: "Link to the imported issue document",
    available: IMPORTED_AVAILABLE,
  },
  {
    name: "plan.url",
    description: "Link to the implementation plan",
    available: `${IMPORTED_AVAILABLE}; the plan is written at plan.completed`,
  },
  {
    name: "plan.excerpt",
    description: "First part of the plan",
    available: PLAN_AVAILABLE,
  },
  {
    name: "plan.openQuestions",
    description: "Open questions, one per line",
    available: PLAN_AVAILABLE,
  },
  {
    name: "pr.url",
    description: "Pull request URL (the first one)",
    available: PULL_REQUEST_AVAILABLE,
  },
  {
    name: "pr.number",
    description: "Pull request number",
    available: PULL_REQUEST_AVAILABLE,
  },
  {
    name: "pr.branch",
    description: "Branch name",
    available: PULL_REQUEST_AVAILABLE,
  },
  {
    name: "pr.urls",
    description: "Every pull request URL of the run, one per line",
    available: PULL_REQUEST_AVAILABLE,
  },
  {
    name: "repository.name",
    description: "First project repository the agent team pushed to",
    available: REPOSITORY_AVAILABLE,
  },
  {
    name: "repository.url",
    description: "Link to the repository",
    available: REPOSITORY_AVAILABLE,
  },
  {
    name: "repository.branch",
    description: "Branch the agent team pushed",
    available: "From execute.completed",
  },
  {
    name: "repository.baseBranch",
    description: "Branch the work is based on",
    available: REPOSITORY_AVAILABLE,
  },
  {
    name: "error.message",
    description: "Failure reason",
    available: "workflow.failed",
  },
  {
    name: "step.name",
    description: "Current step of the project's process, if it has one",
    available: STEP_AVAILABLE,
  },
  {
    name: "step.questions",
    description: "Questions the current step waits on, one per line",
    available: "input.needed of a process step that asks questions",
  },
  {
    name: "reply",
    description:
      "The reply file the process wrote (e.g. an answer for the ticket), from the latest step that has one",
    available: STEP_OUTPUT_AVAILABLE,
  },
  {
    name: "releaseNotes",
    description:
      "Release notes the implement step wrote (markdown), from its latest round",
    available: RELEASE_NOTES_AVAILABLE,
  },
  {
    name: "releaseNotes.url",
    description: "Link to the release notes document of the run",
    available: RELEASE_NOTES_AVAILABLE,
  },
  {
    name: "steps.<step id>.reply",
    description:
      "The reply file of one step of the process, e.g. {{steps.draft.reply}}",
    available: STEP_OUTPUT_AVAILABLE,
  },
  {
    name: "steps.<step id>.document.url",
    description:
      "Link to the document a step of the process published, e.g. {{steps.prd.document.url}}",
    available: STEP_OUTPUT_AVAILABLE,
  },
  {
    name: "steps.<step id>.document.title",
    description: "Title of the document a step of the process published",
    available: STEP_OUTPUT_AVAILABLE,
  },
] as const;

export const WORKFLOW_NAME_MAX = 120;
export const WORKFLOW_DESCRIPTION_MAX = 2000;
export const WORKFLOW_INSTRUCTIONS_MAX = 8000;
export const WORKFLOW_TRIGGERS_MAX = 10;
export const WORKFLOW_ACTIONS_MAX = 20;
export const WORKFLOW_DEFAULT_TITLE_TEMPLATE =
  "{{source.key}}: {{source.title}}";
export const WORKFLOW_PRD_INSTRUCTION_MAX = 4000;

export const workflowAgentModeSchema = z.enum(WorkflowAgentMode);
/** A run event, its legacy `run.*` name included (read as the current one). */
export const workflowRunEventSchema = z.preprocess(
  normalizeWorkflowRunEvent,
  z.enum(WorkflowRunEvent)
);
export const workflowRunStatusSchema = z.enum(WorkflowRunStatus);
export const workflowActionStageSchema = z.enum(WorkflowActionStage);

/**
 * When a run imports its source item as a PRD instead of an Issue
 * (docs/workflows.md "PRD or Issue"): the run's computer reads the
 * instruction and the item and decides, once, before the run's documents are
 * made. Without an instruction every item is an Issue.
 */
export const workflowPrdRuleSchema = z.object({
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_PRD_INSTRUCTION_MAX)
    .nullable()
    .default(null),
});
export type WorkflowPrdRule = z.infer<typeof workflowPrdRuleSchema>;

/** Orchestrated mode: how the orchestrator takes a thread's messages. */
export const workflowOrchestratorConfigSchema = z.object({
  concurrency: z
    .enum(OrchestratorConcurrency)
    .default(OrchestratorConcurrency.Supersede),
  /** How long a thread stays quiet before a turn starts (bursts merge). */
  debounceSeconds: z
    .number()
    .int()
    .min(0)
    .max(ORCHESTRATOR_DEBOUNCE_SECONDS_MAX)
    .default(ORCHESTRATOR_DEBOUNCE_SECONDS_DEFAULT),
  /** How long one turn may take before it is stopped. */
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(ORCHESTRATOR_TURN_TIMEOUT_MINUTES_MAX)
    .default(ORCHESTRATOR_TURN_TIMEOUT_MINUTES_DEFAULT),
  /** Ticket changes whose turn may cancel tasks (task_cancel); [] = never. Comments never cancel. */
  cancelOn: z
    .array(z.enum(OrchestratorTicketChange))
    .max(3)
    .default([...ORCHESTRATOR_CANCEL_ON_DEFAULT])
    .transform((values) => [...new Set(values)]),
});
export type WorkflowOrchestratorConfig = z.infer<
  typeof workflowOrchestratorConfigSchema
>;

export const workflowAgentConfigSchema = z.object({
  mode: workflowAgentModeSchema.default(WorkflowAgentMode.PlanAndExecute),
  /** Plan+execute only: stop in needs_input when the plan has open questions. */
  stopOnOpenQuestions: z.boolean().default(true),
  /**
   * Desktop compute target the loops run on. Must be owned by the run-as user
   * or shared with the org. With runner rules: the runner when none matches.
   */
  computeTargetId: z.string().uuid(),
  /**
   * Runner rules (workflow-runner-rules.ts): the first whose condition holds
   * for the run's source item names the runner, chosen once when the run
   * imports the item; none matching: `computeTargetId`.
   */
  runners: z
    .array(workflowRunnerRuleSchema)
    .max(WORKFLOW_RUNNER_RULES_MAX)
    .default([]),
  /** Optional repo override; must be in the project's team repo pool. Defaults to the project's repo. */
  repository: z
    .object({
      fullName: z.string().trim().min(3).max(200),
      branch: z.string().trim().min(1).max(200),
    })
    .nullable()
    .default(null),
  /** When the source item is imported as a PRD instead of an Issue. */
  prd: workflowPrdRuleSchema.prefault({}),
  /**
   * Process mode: extra guidance appended to the imported item. Orchestrated
   * mode: the orchestrator's rules, sent with every turn.
   */
  instructions: z.string().max(WORKFLOW_INSTRUCTIONS_MAX).default(""),
  /**
   * Orchestrated mode: how the orchestrator takes a thread's messages; its
   * runner is computeTargetId and its rules are instructions.
   */
  orchestrator: workflowOrchestratorConfigSchema.optional(),
  titleTemplate: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .default(WORKFLOW_DEFAULT_TITLE_TEMPLATE),
  /**
   * The workflow's own process (steps between pre and post actions). Null:
   * the project's process, or the built-in AgentFlow flow when the project
   * has none. Lets one project run different processes per workflow, e.g.
   * analysing requirements and answering questions on the same tickets.
   */
  process: projectProcessSchema.nullable().default(null),
});
export type WorkflowAgentConfig = z.infer<typeof workflowAgentConfigSchema>;

export const workflowTriggerInputSchema = z.object({
  /** Present to keep an existing trigger (and its run history link) on update. */
  id: z.string().uuid().optional(),
  /**
   * The project the trigger's runs belong to; omitted: the workflow's
   * project. The trigger's connection key is one of this project's.
   */
  projectId: z.string().uuid().optional(),
  /**
   * Key of a project connection of the trigger's project. Null: the
   * workflow's own HTTP endpoint (type `webhook.request`). The API creates it
   * on first save and keeps it for the life of the workflow; no webhook
   * connection has to be set up in Settings.
   */
  connectionKey: projectConnectionKeySchema.nullable(),
  type: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type WorkflowTriggerInput = z.infer<typeof workflowTriggerInputSchema>;

export const workflowActionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    /**
     * Key of a project connection, resolved in the run's project when the
     * action runs (it must exist in every project the workflow's triggers
     * use). Null: the built-in HTTPS call (type `webhook.post`) of the
     * workflow, or, with `automaticConnection`, the connection picked when
     * the action runs.
     */
    connectionKey: projectConnectionKeySchema.nullable(),
    /**
     * No connection named: the run chooses. An instruction and an action on
     * the source item (a comment, a transition) work on the run's source
     * connection; a repository scoped type (pull requests) on every
     * connection that holds one of the run's repositories; any other type on
     * the project's only connection that offers it.
     */
    automaticConnection: z.boolean().default(false),
    type: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()).default({}),
    stage: workflowActionStageSchema.default(WorkflowActionStage.Post),
    /** Pre stage: ignored (pre actions run on workflow.triggered). Post stage: at least one event. */
    events: z.array(workflowRunEventSchema).max(8).default([]),
    /** Pre stage only: keep going to the agent team when this action fails. */
    continueOnError: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((action, context) => {
    if (action.automaticConnection && action.connectionKey !== null) {
      context.addIssue({
        code: "custom",
        path: ["connectionKey"],
        message: "An action with an automatic connection names none",
      });
    }
    if (action.stage !== WorkflowActionStage.Post) {
      return;
    }
    if (action.events.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Select at least one run event",
      });
    }
    if (action.events.includes(WorkflowRunEvent.Triggered)) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: `${WorkflowRunEvent.Triggered} is reserved for pre actions`,
      });
    }
  });
export type WorkflowActionInput = z.infer<typeof workflowActionInputSchema>;

/** Create and update both send the full workflow (triggers and actions are replaced). */
export const saveWorkflowInputSchema = z
  .object({
    name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
    description: z.string().max(WORKFLOW_DESCRIPTION_MAX).default(""),
    enabled: z.boolean().default(true),
    projectId: z.string().uuid(),
    /**
     * User the loops run as (commit author, concurrency budget). On create it
     * defaults to the caller; on update an omitted value keeps the stored user.
     */
    runAsUserId: z.string().uuid().optional(),
    agent: workflowAgentConfigSchema,
    triggers: z
      .array(workflowTriggerInputSchema)
      .min(1)
      .max(WORKFLOW_TRIGGERS_MAX),
    /** Pre and post actions; order within each stage is the array order. */
    actions: z.array(workflowActionInputSchema).max(WORKFLOW_ACTIONS_MAX),
  })
  // An id names one saved item: given twice, the later item would overwrite
  // the earlier one and the save would silently lose it.
  .superRefine((input, context) => {
    for (const list of ["triggers", "actions"] as const) {
      const seen = new Set<string>();
      input[list].forEach((item, index) => {
        if (!item.id) {
          return;
        }
        if (seen.has(item.id)) {
          context.addIssue({
            code: "custom",
            path: [list, index, "id"],
            message: `The id ${item.id} is given to more than one item`,
          });
        }
        seen.add(item.id);
      });
    }
  });
export type SaveWorkflowInput = z.infer<typeof saveWorkflowInputSchema>;

/**
 * PATCH /workflows/{id}: turn a workflow on or off without re-sending it.
 * Turning it off always succeeds; turning it on re-validates the stored
 * workflow (connections, project, run-as user, compute target).
 */
export const setWorkflowEnabledInputSchema = z.object({
  enabled: z.boolean(),
});
export type SetWorkflowEnabledInput = z.infer<
  typeof setWorkflowEnabledInputSchema
>;

/** Start a run by hand for one trigger, e.g. with a Jira issue key. */
export const startWorkflowRunInputSchema = z.object({
  triggerId: z.string().uuid(),
  input: z.string().trim().min(1).max(65_536),
});
export type StartWorkflowRunInput = z.infer<typeof startWorkflowRunInputSchema>;

export type WorkflowTrigger = {
  id: string;
  /** The project the trigger's runs belong to. */
  projectId: string;
  /** Key of the trigger's project connection; null for the built-in HTTP endpoint. */
  connectionKey: string | null;
  projectConnectionId: string | null;
  /** The organization connection (the managed one for the built-in HTTP endpoint). */
  connectionId: string;
  /** The workflow's own HTTP endpoint (its connection is httpEndpointConnectionId). */
  builtInHttp: boolean;
  type: string;
  config: JsonObject;
  enabled: boolean;
  position: number;
};

export type WorkflowAction = {
  id: string;
  /** Key of the project connection the action uses; null when built-in or automatic. */
  connectionKey: string | null;
  /** Set only for the built-in HTTPS call (the workflow's managed connection). */
  connectionId: string | null;
  /** No connection named: the run's source connection, or the repositories' one. */
  automaticConnection: boolean;
  /** The built-in HTTPS call (on the workflow's own webhook connection). */
  builtInHttp: boolean;
  type: string;
  config: JsonObject;
  stage: WorkflowActionStage;
  /** Post actions: subscribed events. Pre actions: [workflow.triggered]. */
  events: WorkflowRunEvent[];
  continueOnError: boolean;
  enabled: boolean;
  /** Order within the stage. */
  position: number;
};

export type WorkflowUserRef = {
  id: string;
  name: string;
  email: string;
};

export type WorkflowProjectRef = {
  id: string;
  name: string;
};

export type WorkflowRunCounts = {
  total: number;
  active: number;
  succeeded: number;
  failed: number;
};

export type Workflow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  project: WorkflowProjectRef | null;
  runAsUser: WorkflowUserRef | null;
  agent: WorkflowAgentConfig;
  triggers: WorkflowTrigger[];
  actions: WorkflowAction[];
  /**
   * Connection behind the workflow's built-in HTTP trigger: its inbound URL
   * and secret are read from GET /integrations/connections/{id}/inbound.
   */
  httpEndpointConnectionId: string | null;
  runCounts: WorkflowRunCounts;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowsResponse = {
  workflows: Workflow[];
};

export type WorkflowRunSource = {
  provider: string;
  externalId: string;
  key: string;
  title: string | null;
  url: string | null;
};

export type WorkflowRunDocumentRef = {
  id: string;
  slug: string | null;
  title: string;
};

/**
 * The document a run imported its source item as: a PRD when the workflow's
 * PRD instruction found a product requirement, an Issue (FEATURE) otherwise.
 */
export type WorkflowRunSourceDocumentType =
  | typeof DocumentType.Prd
  | typeof DocumentType.Feature;

export type WorkflowRunSourceDocumentRef = WorkflowRunDocumentRef & {
  type: WorkflowRunSourceDocumentType;
};

/** A document an agent step of the run's process published. */
export type WorkflowRunPublishedDocument = WorkflowRunDocumentRef & {
  type: ProcessDocumentType;
  stepId: string;
};

export type WorkflowRunError = {
  code: string;
  message: string;
};

export type WorkflowRunSummary = {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerId: string | null;
  triggerType: string | null;
  status: WorkflowRunStatus;
  source: WorkflowRunSource;
  /**
   * The pull requests the run opened, one per project repository it changed,
   * in the order of the run's repositories.
   */
  pullRequests: WorkflowRunPullRequest[];
  error: WorkflowRunError | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type WorkflowRunLoopRef = {
  loopId: string;
  command: string;
  status: string;
  /** True when the loop was started by a person (e.g. after needs_input) and adopted by the run. */
  adopted: boolean;
  /** The process step a STEP loop ran; null for PLAN / EXECUTE. */
  stepId: string | null;
  prUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type WorkflowActionRun = {
  id: string;
  actionId: string | null;
  actionType: string;
  stage: WorkflowActionStage;
  event: WorkflowRunEvent;
  /** Run cycle (increments when a needs_input run resumes). */
  cycle: number;
  status: WorkflowActionRunStatus;
  attempts: number;
  lastError: string | null;
  /** Provider reference of what was created, e.g. a comment id or URL. */
  externalRef: string | null;
  /** What an instruction action's agent proposed and how each operation went. */
  instruction: WorkflowInstructionRunDetail | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  /** The imported source item: a PRD or an Issue. */
  feature: WorkflowRunSourceDocumentRef | null;
  /**
   * How the workflow's PRD instruction classified the item; null without an
   * instruction (the item is an Issue) and while the run's computer decides.
   */
  sourceClassification: WorkflowRunSourceClassification | null;
  plan: WorkflowRunDocumentRef | null;
  /** Documents the process steps published (a PRD, a bug analysis, ...). */
  documents: WorkflowRunPublishedDocument[];
  branchName: string | null;
  loops: WorkflowRunLoopRef[];
  /** Agent sessions the run's loops ran, newest first. */
  sessions: WorkflowRunSession[];
  actionRuns: WorkflowActionRun[];
  /** The project process the run follows; null on the built-in flow. */
  process: RunProcessView | null;
  /** The integration tool calls of the run's agents, oldest first. */
  toolCalls: WorkflowRunToolCall[];
  /** The failed step a workflow administrator can run again; null otherwise. */
  retryStep: WorkflowRunRetryStep | null;
};

/** A process step of a failed run that POST /workflow-runs/{id}/retry runs again. */
export type WorkflowRunRetryStep = {
  id: string;
  name: string;
  /** The step's failed agent session can go on (WorkflowRunRetryMode.Resume). */
  resumable: boolean;
};

export type WorkflowRunsResponse = {
  runs: WorkflowRunSummary[];
  nextCursor: string | null;
};

/**
 * Instruction actions: an agent on the run's computer reads the instruction
 * in the run's workspace (its plan folder: the PRD, the plan, the work the
 * agent team did) and acts through the integration tools its grant allows
 * (integration-tools.ts). The API checks and carries out every call, so the
 * connection's credentials never leave the server.
 */
export const WORKFLOW_INSTRUCTION_ACTION_TYPE = "agentflow.instruction";
export const WORKFLOW_INSTRUCTION_MAX = 4000;
/** Writes one instruction attempt may carry out through its tools. */
export const WORKFLOW_INSTRUCTION_OPERATIONS_MAX = 5;
/** Writes one STEP loop of a process agent step may carry out. */
export const PROCESS_STEP_TOOL_WRITES_MAX = 100;

export const workflowInstructionConfigSchema = z.object({
  instruction: z.string().trim().min(1).max(WORKFLOW_INSTRUCTION_MAX),
  /**
   * What the agent may write (connection-grants.ts). Without it the agent
   * only reads the run's source item.
   */
  connections: connectionGrantsSchema.optional(),
});
export type WorkflowInstructionConfig = z.infer<
  typeof workflowInstructionConfigSchema
>;

/** How one operation an instruction's agent proposed went. */
export const WorkflowInstructionOperationStatus = {
  Succeeded: "succeeded",
  Failed: "failed",
  Skipped: "skipped",
  /** Not run: an earlier operation of the instruction failed. */
  NotRun: "not_run",
  /** Waits for a person's approval (the run page has the decision). */
  PendingApproval: "pending_approval",
} as const;
export type WorkflowInstructionOperationStatus =
  (typeof WorkflowInstructionOperationStatus)[keyof typeof WorkflowInstructionOperationStatus];

/** How one integration tool call of an instruction's agent went, for the run page. */
export const workflowInstructionOperationResultSchema = z.object({
  /** The provider action type, e.g. jira.add_comment; a read tool's name. */
  type: z.string(),
  /** The project connection key the call named; absent on older runs. */
  connection: z.string().nullable().optional(),
  /** The operation's options as the agent wrote them (long text cut). */
  config: z.record(z.string(), z.json()),
  status: z.enum(WorkflowInstructionOperationStatus),
  /** Provider reference of what was created, e.g. a comment id or URL. */
  externalRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorkflowInstructionOperationResult = z.infer<
  typeof workflowInstructionOperationResultSchema
>;

/** An instruction action run: what its agent did, for the run page. */
export const workflowInstructionRunDetailSchema = z.object({
  /** The agent's note: what it did and why, or none. */
  note: z.string().nullable(),
  operations: z.array(workflowInstructionOperationResultSchema),
  /** Claude Code's own cost of the agent session; null when unknown. */
  costUsd: z.number().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type WorkflowInstructionRunDetail = z.infer<
  typeof workflowInstructionRunDetailSchema
>;

/** A run event's current name for a current or legacy (`run.*`) one. */
export function normalizeWorkflowRunEvent(value: unknown): unknown {
  return typeof value === "string"
    ? (LEGACY_WORKFLOW_RUN_EVENTS[value] ?? value)
    : value;
}

/** What decided a run's source item is a PRD or an Issue (`agent.prd`). */
export const WorkflowRunSourceClassificationOrigin = {
  /** The run's computer read the PRD instruction and the item. */
  Instruction: "instruction",
  /**
   * The computer gave no usable answer (it failed, timed out or answered
   * something else), so the item is an Issue.
   */
  Fallback: "fallback",
} as const;
export type WorkflowRunSourceClassificationOrigin =
  (typeof WorkflowRunSourceClassificationOrigin)[keyof typeof WorkflowRunSourceClassificationOrigin];

/** How the workflow's PRD instruction classified a run's source item. */
export type WorkflowRunSourceClassification = {
  type: WorkflowRunSourceDocumentType;
  origin: WorkflowRunSourceClassificationOrigin;
  /** The computer's reason, or why it gave no usable answer. */
  reason: string;
};

/**
 * An agent session one of the run's loops ran (SessionDetail.sourceLoopId),
 * opened at /sessions/{id}.
 */
export type WorkflowRunSession = {
  /** Session artifact id. */
  id: string;
  slug: string | null;
  name: string | null;
  loopId: string;
  /** LoopCommand of that loop. */
  command: string;
  /** The process step a STEP loop ran; null for PLAN / EXECUTE. */
  stepId: string | null;
  /** DisplayedSessionStatus (session-status.ts), as the Sessions list shows it. */
  status: string;
  harness: string;
  model: string | null;
  startedAt: Date;
  lastActivityAt: Date | null;
  endedAt: Date | null;
};

/** A pull request a run opened in one of its project's repositories. */
export type WorkflowRunPullRequest = {
  url: string;
  number: number | null;
  /** Full name of the repository; null when the run recorded no repository. */
  repository: string | null;
  /** Branch the pull request is opened from. */
  branch: string | null;
};

/** How POST /workflow-runs/{id}/retry runs the failed step again. */
export const WorkflowRunRetryMode = {
  /** The failed agent session goes on in a fork (`--resume --fork-session`). */
  Resume: "resume",
  /** The step starts over in a new agent session. */
  Restart: "restart",
} as const;
export type WorkflowRunRetryMode =
  (typeof WorkflowRunRetryMode)[keyof typeof WorkflowRunRetryMode];

/** Body of POST /workflow-runs/{id}/retry; without a mode the step restarts. */
export const workflowRunRetryRequestSchema = z.object({
  mode: z.enum(WorkflowRunRetryMode).default(WorkflowRunRetryMode.Restart),
});
export type WorkflowRunRetryRequest = z.input<
  typeof workflowRunRetryRequestSchema
>;

/** The orchestrator settings of an agent config, with defaults when unset. */
export function resolveWorkflowOrchestratorConfig(
  agent: Pick<WorkflowAgentConfig, "orchestrator">
): WorkflowOrchestratorConfig {
  return agent.orchestrator ?? workflowOrchestratorConfigSchema.parse({});
}
