import { z } from "zod";

/**
 * The project orchestrator's runtime (docs/orchestrator.md): cases (a ticket
 * or a thread of work), conversations (where messages come from and answers
 * go: a comment thread, a Teams thread, a ticket), messages (external and
 * internal requests), turns (one run of the orchestrator's agent on its
 * runner), anchors (the comments the orchestrator posted, so a reply finds
 * its conversation), tasks (a runner command the orchestrator asked for),
 * waits (what a conversation waits for before its next turn) and decisions
 * (an approval asked of people).
 */

export const OrchestratorCaseStatus = {
  Open: "open",
  Closed: "closed",
} as const;
export type OrchestratorCaseStatus =
  (typeof OrchestratorCaseStatus)[keyof typeof OrchestratorCaseStatus];

export const OrchestratorConversationStatus = {
  /** Nothing to do until a message arrives. */
  Idle: "idle",
  /** A turn runs. */
  Turn: "turn",
  /** Waits for tasks or for people (its waits say which). */
  Waiting: "waiting",
  Closed: "closed",
} as const;
export type OrchestratorConversationStatus =
  (typeof OrchestratorConversationStatus)[keyof typeof OrchestratorConversationStatus];

/** Where a message comes from: a person or a system outside, or AgentFlow. */
export const OrchestratorMessageOrigin = {
  External: "external",
  Internal: "internal",
} as const;
export type OrchestratorMessageOrigin =
  (typeof OrchestratorMessageOrigin)[keyof typeof OrchestratorMessageOrigin];

export const OrchestratorMessageKind = {
  /** A mention, a reply, a post: someone asks something. */
  Message: "message",
  /** The tasks a wait named are done (or one failed): their results. */
  TaskResults: "task_results",
  /** People decided on a decision the orchestrator asked for. */
  Decision: "decision",
  /** A wait reached its deadline. */
  Deadline: "deadline",
  /** The orchestrator's own message, posted in the thread (reply). */
  Reply: "reply",
  /** The ticket moved to another status. */
  StatusChanged: "status_changed",
  /** A label was added to the ticket. */
  LabelAdded: "label_added",
  /** A label was removed from the ticket. */
  LabelRemoved: "label_removed",
} as const;
export type OrchestratorMessageKind =
  (typeof OrchestratorMessageKind)[keyof typeof OrchestratorMessageKind];

export const OrchestratorTurnStatus = {
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  /** Stopped for a newer message; the next turn takes its messages too. */
  Superseded: "superseded",
} as const;
export type OrchestratorTurnStatus =
  (typeof OrchestratorTurnStatus)[keyof typeof OrchestratorTurnStatus];

/** How a turn ended: what the conversation does next. */
export const OrchestratorTurnEnd = {
  /** Waits for tasks (wait_for). */
  WaitTasks: "wait_tasks",
  /** Waits for a person (wait_human, or a turn that declared nothing). */
  WaitHuman: "wait_human",
  /** The case is done (close_case). */
  Close: "close",
} as const;
export type OrchestratorTurnEnd =
  (typeof OrchestratorTurnEnd)[keyof typeof OrchestratorTurnEnd];

export const OrchestratorTaskStatus = {
  /** Waits for its runner (a personal runner that runs one task at a time). */
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  /** Stopped by task_cancel on a ticket change; never resumed. */
  Cancelled: "cancelled",
} as const;
export type OrchestratorTaskStatus =
  (typeof OrchestratorTaskStatus)[keyof typeof OrchestratorTaskStatus];

export const OrchestratorWaitKind = {
  /** Every task is done (or one failed, with onFailure wake). */
  All: "all",
  /** The first task is done. */
  Any: "any",
} as const;
export type OrchestratorWaitKind =
  (typeof OrchestratorWaitKind)[keyof typeof OrchestratorWaitKind];

export const OrchestratorDecisionStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
} as const;
export type OrchestratorDecisionStatus =
  (typeof OrchestratorDecisionStatus)[keyof typeof OrchestratorDecisionStatus];

/** Where a decision was given. */
export const OrchestratorDecisionVia = {
  /** An admin pressed the button in AgentFlow. */
  Button: "button",
  /** Someone said it in the thread; the orchestrator recorded it. */
  Message: "message",
} as const;
export type OrchestratorDecisionVia =
  (typeof OrchestratorDecisionVia)[keyof typeof OrchestratorDecisionVia];

// ---------------------------------------------------------------------------
// A turn on the orchestrator's runner (desktop command)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TURN_GATEWAY_PATH = "/api/gateway/orchestrator/turn";
export const ORCHESTRATOR_TURN_OPERATION_ID = "orchestrator_turn";
export const ORCHESTRATOR_TURN_PROMPT_MAX = 200_000;
/** Stops a running turn for a newer message (concurrency `supersede`). */
export const ORCHESTRATOR_TURN_CANCEL_GATEWAY_PATH =
  "/api/gateway/orchestrator/turn/cancel";
export const ORCHESTRATOR_TURN_CANCEL_OPERATION_ID = "orchestrator_turn_cancel";
export const orchestratorTurnCancelRequestSchema = z.object({
  turnId: z.uuid(),
});
/** The error of a turn stopped for a newer message. */
export const ORCHESTRATOR_TURN_STOPPED_ERROR =
  "The turn was stopped for a newer message.";
export const ORCHESTRATOR_TURN_ANSWER_MAX = 8000;
export const ORCHESTRATOR_TURN_ERROR_MAX = 2000;
/** The MCP server name the orchestrator's tools are served under. */
export const ORCHESTRATOR_MCP_SERVER_NAME = "agentflow_orchestrator";

export const orchestratorTurnRequestSchema = z.object({
  turnId: z.uuid(),
  /** Names the turn's working folder; sessions resume per project. */
  projectId: z.uuid(),
  /** The conversation's Claude session to resume; null: a new session. */
  sessionId: z.string().min(1).max(100).nullable(),
  prompt: z.string().min(1).max(ORCHESTRATOR_TURN_PROMPT_MAX),
  /** How long the turn may run on the computer. */
  timeoutMs: z.number().int().positive(),
});
export type OrchestratorTurnRequest = z.infer<
  typeof orchestratorTurnRequestSchema
>;

/** The `result` line of the computer's answer. */
export const orchestratorTurnResultSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("result"),
    ok: z.literal(true),
    /** The agent's final note (what it did); its answers went out by tool. */
    answer: z.string().max(ORCHESTRATOR_TURN_ANSWER_MAX),
    /** The Claude session the next turn of the conversation resumes. */
    sessionId: z.string().max(100).nullable(),
    costUsd: z.number().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("result"),
    ok: z.literal(false),
    error: z.string().max(ORCHESTRATOR_TURN_ERROR_MAX),
    retryable: z.boolean(),
    sessionId: z.string().max(100).nullable(),
  }),
]);
export type OrchestratorTurnResult = z.infer<
  typeof orchestratorTurnResultSchema
>;

// ---------------------------------------------------------------------------
// The orchestrator's tools (an MCP session per turn)
// ---------------------------------------------------------------------------

/** Prefix of a turn's tool session token (`ost_…`). */
export const ORCHESTRATOR_TOKEN_PREFIX = "ost_";
/** The runner exchanges its turn for the tool session token here. */
export const ORCHESTRATOR_SESSION_ROUTE = "/desktop/orchestrator-sessions";
/** apps/mcp forwards a token's tool list and calls here. */
export const ORCHESTRATOR_TOOLS_SESSION_ROUTE = "/orchestrator-tools/session";
export const ORCHESTRATOR_TOOLS_CALL_ROUTE = "/orchestrator-tools/call";

export const orchestratorSessionRequestSchema = z.object({
  turnId: z.uuid(),
});

export const OrchestratorToolName = {
  CaseGet: "case_get",
  CaseUpdateNotes: "case_update_notes",
  ConversationAttachCase: "conversation_attach_case",
  RunnersList: "runners_list",
  SourceItemGet: "source_item_get",
  Reply: "reply",
  TaskRun: "task_run",
  TaskGet: "task_get",
  TaskCancel: "task_cancel",
  WaitFor: "wait_for",
  WaitHuman: "wait_human",
  CloseCase: "close_case",
  RequestDecision: "request_decision",
  RecordDecision: "record_decision",
  EditReply: "edit_reply",
} as const;
export type OrchestratorToolName =
  (typeof OrchestratorToolName)[keyof typeof OrchestratorToolName];

/**
 * Where a task's agent leaves its answer for the orchestrator (a workspace
 * path; on a personal runner it is in the task's own work directory).
 */
export const ORCHESTRATOR_TASK_REPLY_FILE =
  ".agentflow-ai/work/orchestrator-reply.md";
export const ORCHESTRATOR_TASK_REPLY_MAX = 30_000;

/** An admin's decision in AgentFlow (POST /orchestrator/decisions/{id}). */
export const decideOrchestratorDecisionInputSchema = z.object({
  approved: z.boolean(),
  comment: z.string().trim().max(4000).optional(),
});
export type DecideOrchestratorDecisionInput = z.infer<
  typeof decideOrchestratorDecisionInputSchema
>;

// ---------------------------------------------------------------------------
// Case reads and admin actions (project -> Orchestrator, case page). All
// dates are ISO strings.
// ---------------------------------------------------------------------------

export type OrchestratorCaseSummary = {
  id: string;
  projectId: string;
  workflowId: string;
  title: string;
  sourceKey: string | null;
  status: OrchestratorCaseStatus;
  conversationCount: number;
  pendingDecisionCount: number;
  /** Queued + running tasks. */
  activeTaskCount: number;
  turnRunning: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrchestratorTurnUsage = {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type OrchestratorCaseMessage = {
  id: string;
  conversationId: string;
  origin: OrchestratorMessageOrigin;
  kind: OrchestratorMessageKind;
  actor: string | null;
  text: string;
  turnId: string | null;
  createdAt: string;
};

export type OrchestratorCaseTurn = {
  id: string;
  conversationId: string;
  status: OrchestratorTurnStatus;
  ended: OrchestratorTurnEnd | null;
  summary: string | null;
  error: string | null;
  usage: OrchestratorTurnUsage | null;
  runnerName: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type OrchestratorCaseTask = {
  id: string;
  conversationId: string;
  turnId: string | null;
  command: string;
  args: string;
  prompt: string;
  mode: string;
  runnerName: string | null;
  computeTargetId: string | null;
  status: OrchestratorTaskStatus;
  fork: boolean;
  resumeTaskId: string | null;
  loopId: string | null;
  reply: string | null;
  questions: Array<{ id: string; question: string; options?: string[] }>;
  error: string | null;
  /** Why a queued task has not started (a busy runner). */
  waiting: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type OrchestratorCaseWait = {
  id: string;
  conversationId: string;
  kind: OrchestratorWaitKind;
  taskIds: string[];
  deadline: string | null;
  wakeOnFailure: boolean;
  firedAt: string | null;
  createdAt: string;
};

export type OrchestratorCaseDecision = {
  id: string;
  conversationId: string;
  question: string;
  status: OrchestratorDecisionStatus;
  via: OrchestratorDecisionVia | null;
  decidedBy: string | null;
  comment: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type OrchestratorCaseConversation = {
  id: string;
  channelKey: string;
  status: OrchestratorConversationStatus;
  createdAt: string;
  messages: OrchestratorCaseMessage[];
  turns: OrchestratorCaseTurn[];
};

export type OrchestratorCaseDetail = OrchestratorCaseSummary & {
  notes: string;
  project: { id: string; name: string };
  workflow: { id: string; name: string };
  conversations: OrchestratorCaseConversation[];
  tasks: OrchestratorCaseTask[];
  waits: OrchestratorCaseWait[];
  decisions: OrchestratorCaseDecision[];
};

export const updateOrchestratorCaseInputSchema = z.object({
  status: z.enum(OrchestratorCaseStatus),
});
export type UpdateOrchestratorCaseInput = z.infer<
  typeof updateOrchestratorCaseInputSchema
>;

/** What happens to a new message while a turn on the same thread runs. */
export const OrchestratorConcurrency = {
  /** Stop the running turn; the next one handles both messages. */
  Supersede: "supersede",
  /** Let the running turn finish; the next one takes every new message. */
  Queue: "queue",
} as const;
export type OrchestratorConcurrency =
  (typeof OrchestratorConcurrency)[keyof typeof OrchestratorConcurrency];

export const ORCHESTRATOR_DEBOUNCE_SECONDS_DEFAULT = 20;
export const ORCHESTRATOR_DEBOUNCE_SECONDS_MAX = 600;
export const ORCHESTRATOR_TURN_TIMEOUT_MINUTES_DEFAULT = 10;
export const ORCHESTRATOR_TURN_TIMEOUT_MINUTES_MAX = 60;

/**
 * A change of the ticket itself (not a comment): the kinds of the
 * orchestrator's messages for them and the values of
 * agent.orchestrator.cancelOn.
 */
export const OrchestratorTicketChange = {
  StatusChanged: "status_changed",
  LabelAdded: "label_added",
  LabelRemoved: "label_removed",
} as const;
export type OrchestratorTicketChange =
  (typeof OrchestratorTicketChange)[keyof typeof OrchestratorTicketChange];

/** Ticket changes whose turn may cancel tasks when cancelOn is unset. */
export const ORCHESTRATOR_CANCEL_ON_DEFAULT: readonly OrchestratorTicketChange[] =
  [
    OrchestratorTicketChange.StatusChanged,
    OrchestratorTicketChange.LabelRemoved,
  ];
