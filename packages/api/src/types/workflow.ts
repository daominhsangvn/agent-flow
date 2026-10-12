import type { DocumentType } from "@agentflow-ai/loops-api/document";
import { z } from "zod";
import type { JsonObject } from "./common";
import {
  type ProcessDocumentType,
  projectProcessSchema,
  type RunProcessView,
} from "./project-process.ts";
import { WorkflowAgentMode } from "./workflow-agent-mode.ts";

/**
 * Event-driven workflows: one or more triggers (Jira issue assigned to the
 * bot, Azure DevOps work item assigned, generic HTTPS request, ...) start an
 * agent-team run on a desktop compute target, and optional post actions
 * (comment on the source item, Teams message, HTTPS callback, ...) run on run
 * events. Triggers and actions are provided by integration connections (see
 * ./integration.ts); nothing here is provider-specific.
 *
 * The engine never writes to a source system on its own: every change in Jira,
 * Azure DevOps, Teams, ... is a pre action or post action configured by an admin.
 *
 * Flow: trigger -> pre actions (sequential, before the agent team) -> agent
 * team (import, PLAN, optional EXECUTE) -> post actions (on run events).
 *
 * Run lifecycle:
 *   received -> [pre_actions] -> ingesting -> planning -> [executing] -> succeeded
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
 * Run events. Pre actions always run on `run.triggered`; post actions
 * subscribe to any of the others.
 */
export const WorkflowRunEvent = {
  /** A trigger fired (or a needs_input run resumed). Pre actions run on it. */
  Triggered: "run.triggered",
  /** The agent team was launched (PLAN loop dispatched). */
  Started: "run.started",
  /** The PLAN loop completed; the plan document has content. */
  PlanReady: "run.plan_ready",
  /**
   * The run waits for a person: the plan or a process step has open
   * questions, or a process step waits for an approval.
   */
  NeedsInput: "run.needs_input",
  /** Plan mode: plan ready. Plan+execute mode: implementation finished (PR opened). */
  Succeeded: "run.succeeded",
  Failed: "run.failed",
} as const;
export type WorkflowRunEvent =
  (typeof WorkflowRunEvent)[keyof typeof WorkflowRunEvent];

/** Events a post action may subscribe to (everything except run.triggered). */
export const WORKFLOW_POST_ACTION_EVENTS: readonly WorkflowRunEvent[] = [
  WorkflowRunEvent.Started,
  WorkflowRunEvent.PlanReady,
  WorkflowRunEvent.NeedsInput,
  WorkflowRunEvent.Succeeded,
  WorkflowRunEvent.Failed,
];

/**
 * When an action runs.
 * - pre: right after the trigger fires, before the agent team starts, in the
 *   configured order. A failed pre action stops the run unless
 *   continueOnError is set.
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
  Succeeded: "succeeded",
  Failed: "failed",
  Skipped: "skipped",
} as const;
export type WorkflowActionRunStatus =
  (typeof WorkflowActionRunStatus)[keyof typeof WorkflowActionRunStatus];

/**
 * Variables available to {{template}} fields of actions and to the issue title
 * template. Unknown variables render as an empty string.
 */
export const WORKFLOW_TEMPLATE_VARIABLES = [
  { name: "summary", description: "Ready-made markdown summary for the event" },
  {
    name: "event",
    description: "Run event, e.g. run.triggered or run.succeeded",
  },
  { name: "run.status", description: "Run status" },
  { name: "run.url", description: "Link to the run in AgentFlow" },
  { name: "workflow.name", description: "Workflow name" },
  { name: "source.provider", description: "Provider of the source item" },
  { name: "source.key", description: "Source item key, e.g. PROJ-123" },
  { name: "source.title", description: "Source item title" },
  { name: "source.url", description: "Link to the source item" },
  { name: "feature.url", description: "Link to the imported issue document" },
  { name: "plan.url", description: "Link to the implementation plan" },
  { name: "plan.excerpt", description: "First part of the plan" },
  { name: "plan.openQuestions", description: "Open questions, one per line" },
  { name: "pr.url", description: "Pull request URL (the first one)" },
  { name: "pr.number", description: "Pull request number" },
  { name: "pr.branch", description: "Branch name" },
  {
    name: "pr.urls",
    description: "Every pull request URL of the run, one per line",
  },
  {
    name: "repository.name",
    description: "First project repository the agent team pushed to",
  },
  { name: "repository.url", description: "Link to the repository" },
  {
    name: "repository.branch",
    description: "Branch the agent team pushed",
  },
  {
    name: "repository.baseBranch",
    description: "Branch the work is based on",
  },
  { name: "error.message", description: "Failure reason" },
  {
    name: "step.name",
    description: "Current step of the project's process, if it has one",
  },
  {
    name: "step.questions",
    description: "Questions the current step waits on, one per line",
  },
  {
    name: "reply",
    description:
      "The reply file the process wrote (e.g. an answer for the ticket), from the latest step that has one",
  },
  {
    name: "steps.<step id>.reply",
    description:
      "The reply file of one step of the process, e.g. {{steps.draft.reply}}",
  },
  {
    name: "steps.<step id>.document.url",
    description:
      "Link to the document a step of the process published, e.g. {{steps.prd.document.url}}",
  },
  {
    name: "steps.<step id>.document.title",
    description: "Title of the document a step of the process published",
  },
] as const;

export const WORKFLOW_NAME_MAX = 120;
export const WORKFLOW_DESCRIPTION_MAX = 2000;
export const WORKFLOW_INSTRUCTIONS_MAX = 8000;
export const WORKFLOW_TRIGGERS_MAX = 10;
export const WORKFLOW_ACTIONS_MAX = 20;
export const WORKFLOW_DEFAULT_TITLE_TEMPLATE =
  "{{source.key}}: {{source.title}}";

export const workflowAgentModeSchema = z.enum(WorkflowAgentMode);
export const workflowRunEventSchema = z.enum(WorkflowRunEvent);
export const workflowRunStatusSchema = z.enum(WorkflowRunStatus);
export const workflowActionStageSchema = z.enum(WorkflowActionStage);

export const workflowAgentConfigSchema = z.object({
  mode: workflowAgentModeSchema.default(WorkflowAgentMode.PlanAndExecute),
  /** Plan+execute only: stop in needs_input when the plan has open questions. */
  stopOnOpenQuestions: z.boolean().default(true),
  /** Desktop compute target the loops run on. Must be owned by the run-as user or shared with the org. */
  computeTargetId: z.string().uuid(),
  /** Optional repo override; must be in the project's team repo pool. Defaults to the project's repo. */
  repository: z
    .object({
      fullName: z.string().trim().min(3).max(200),
      branch: z.string().trim().min(1).max(200),
    })
    .nullable()
    .default(null),
  /** Extra guidance appended to the imported issue document. */
  instructions: z.string().max(WORKFLOW_INSTRUCTIONS_MAX).default(""),
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
   * Null: the workflow's own HTTP endpoint (type `webhook.request`). The API
   * creates it on first save and keeps it for the life of the workflow; no
   * webhook connection has to be set up in Settings.
   */
  connectionId: z.string().uuid().nullable(),
  type: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type WorkflowTriggerInput = z.infer<typeof workflowTriggerInputSchema>;

export const workflowActionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    /** Null: the built-in HTTPS call (type `webhook.post`) of the workflow. */
    connectionId: z.string().uuid().nullable(),
    type: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()).default({}),
    stage: workflowActionStageSchema.default(WorkflowActionStage.Post),
    /** Pre stage: ignored (pre actions run on run.triggered). Post stage: at least one event. */
    events: z.array(workflowRunEventSchema).max(8).default([]),
    /** Pre stage only: keep going to the agent team when this action fails. */
    continueOnError: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((action, context) => {
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
        message: "run.triggered is reserved for pre actions",
      });
    }
  });
export type WorkflowActionInput = z.infer<typeof workflowActionInputSchema>;

/** Create and update both send the full workflow (triggers and actions are replaced). */
export const saveWorkflowInputSchema = z.object({
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
  connectionId: string;
  /** The built-in HTTPS call (on the workflow's own webhook connection). */
  builtInHttp: boolean;
  type: string;
  config: JsonObject;
  stage: WorkflowActionStage;
  /** Post actions: subscribed events. Pre actions: [run.triggered]. */
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
 * The document a run imported its source item as: a PRD for a product
 * requirement (item type "PRD"), an Issue (FEATURE) for anything else.
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
  prUrl: string | null;
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
  completedAt: Date | null;
  createdAt: Date;
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  /** The imported source item: a PRD or an Issue. */
  feature: WorkflowRunSourceDocumentRef | null;
  plan: WorkflowRunDocumentRef | null;
  /** Documents the process steps published (a PRD, a bug analysis, ...). */
  documents: WorkflowRunPublishedDocument[];
  branchName: string | null;
  loops: WorkflowRunLoopRef[];
  actionRuns: WorkflowActionRun[];
  /** The project process the run follows; null on the built-in flow. */
  process: RunProcessView | null;
};

export type WorkflowRunsResponse = {
  runs: WorkflowRunSummary[];
  nextCursor: string | null;
};
