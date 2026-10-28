import { z } from "zod";
import type { JsonObject, JsonValue } from "./common.ts";
import { SourceOperation } from "./connection-grants.ts";

/**
 * Integration tools for agents (docs/workflows.md "Integration tools"): an
 * instruction's agent or a process agent step's agent reads the run's source
 * item and carries out the writes its `connections:` grant allows through
 * the AgentFlow MCP server, never with credentials of its own.
 *
 * The runner the agent was dispatched to exchanges the action run (or the
 * step's loop) for a session token (`POST /desktop/integration-sessions`) and
 * starts the agent
 * with an MCP config naming `INTEGRATION_MCP_SERVER_NAME`, the token in its
 * environment only. `apps/mcp` lists the session's tools from
 * `GET /integration-tools/session` and forwards each call to
 * `POST /integration-tools/call`, where the API checks the grant again and
 * runs the operation with the project connection's credentials.
 */

export const INTEGRATION_TOOL_TOKEN_PREFIX = "ist_";
export const INTEGRATION_MCP_SERVER_NAME = "agentflow_integrations";
/** The agent's environment variable the MCP config reads the token from. */
export const INTEGRATION_TOOL_TOKEN_ENV = "AGENTFLOW_INTEGRATION_TOKEN";

export const INTEGRATION_SESSION_ROUTE = "/desktop/integration-sessions";
export const INTEGRATION_TOOLS_SESSION_ROUTE = "/integration-tools/session";
export const INTEGRATION_TOOLS_CALL_ROUTE = "/integration-tools/call";
/**
 * Where an agent uploads a file for a comment (`source_item_comment`
 * `attachments`): the raw bytes as the body, the session token as Bearer,
 * the file name in `INTEGRATION_FILE_NAME_HEADER` and its type as
 * Content-Type. The file is attached to the run's source item at once.
 */
export const INTEGRATION_TOOLS_FILES_ROUTE = "/integration-tools/files";
/** The agent's environment variable holding the full upload URL (the runner sets it). */
export const INTEGRATION_FILES_URL_ENV = "AGENTFLOW_INTEGRATION_FILES_URL";
/**
 * The agent's environment variable naming the runner's upload helper:
 * `"$AGENTFLOW_ATTACH" <file> [content-type]` uploads the file and prints the
 * answer, so the agent never handles the session token itself.
 */
export const INTEGRATION_ATTACH_COMMAND_ENV = "AGENTFLOW_ATTACH";
/** URI-encoded file name of an upload. */
export const INTEGRATION_FILE_NAME_HEADER = "x-file-name";
/** Below the 10 MB the API proxy buffers by default. */
export const INTEGRATION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const INTEGRATION_ATTACHMENT_NAME_MAX = 200;
/** Files one comment may show. */
export const INTEGRATION_COMMENT_ATTACHMENTS_MAX = 10;

/** The tools every session may have; external writes are named by operationToolName. */
export const IntegrationToolName = {
  Overview: "integrations_overview",
  SourceItemGet: "source_item_get",
  /** Read the text of one file attached to the run's source item. */
  SourceItemAttachmentRead: "source_item_attachment_read",
  ConnectionGetItem: "connection_get_item",
  SourceItemComment: "source_item_comment",
  SourceItemTransition: "source_item_transition",
  SourceItemLabel: "source_item_label",
  SourceItemLink: "source_item_link",
  /** Recorded for a file upload (INTEGRATION_TOOLS_FILES_ROUTE); not an MCP tool. */
  SourceItemAttach: "source_item_attach",
  PullRequestsList: "pull_requests_list",
  PullRequestThreads: "pull_request_threads",
  PullRequestReply: "pull_request_reply",
  PullRequestResolve: "pull_request_resolve",
} as const;
export type IntegrationToolName =
  (typeof IntegrationToolName)[keyof typeof IntegrationToolName];

/** The tool of an external operation: `microsoft_teams.post_message` -> `microsoft_teams_post_message`. */
export function operationToolName(operationType: string): string {
  return operationType.replaceAll(".", "_");
}

export const IntegrationToolAccess = {
  Read: "read",
  Write: "write",
} as const;
export type IntegrationToolAccess =
  (typeof IntegrationToolAccess)[keyof typeof IntegrationToolAccess];

export const IntegrationToolCallStatus = {
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  /** Outside the session's grants: nothing was sent to the provider. */
  Refused: "refused",
  /** The grant requires approval: waits for a person to decide. */
  PendingApproval: "pending_approval",
  /** A person rejected it: nothing was sent to the provider. */
  Rejected: "rejected",
} as const;
export type IntegrationToolCallStatus =
  (typeof IntegrationToolCallStatus)[keyof typeof IntegrationToolCallStatus];

/** The agent a runner asks a session for: an instruction attempt or a STEP loop. */
export const integrationSessionRequestSchema = z.union([
  z.object({ actionRunId: z.uuid() }).strict(),
  z.object({ loopId: z.uuid() }).strict(),
]);
export type IntegrationSessionRequest = z.infer<
  typeof integrationSessionRequestSchema
>;

export type IntegrationSessionGrant = {
  /** Bearer token for the MCP server; valid while the agent's attempt runs. */
  token: string;
  expiresAt: string;
  /** The MCP endpoint the agent connects to. */
  mcpUrl: string;
  /**
   * The upload URL for comment attachments; the runner fills it from the
   * API origin it asked the session from (the API does not send it).
   */
  filesUrl?: string;
};

/** A file an agent uploaded to the run's source item, as the upload answers. */
export type IntegrationUploadedFile = {
  /** Pass it in `source_item_comment` `attachments`. */
  id: string;
  name: string;
  contentType: string;
  size: number;
};

export type IntegrationToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type IntegrationToolDescriptor = {
  name: string;
  title: string;
  description: string;
  /** JSON Schema of the tool's arguments, already narrowed to the session. */
  inputSchema: JsonObject;
  annotations: IntegrationToolAnnotations;
};

export type IntegrationToolSessionDescriptor = {
  /** MCP server instructions: what this session may and may not do. */
  instructions: string;
  tools: IntegrationToolDescriptor[];
};

export const INTEGRATION_TOOL_INPUT_MAX_BYTES = 64_000;

export const integrationToolCallRequestSchema = z.object({
  tool: z.string().trim().min(1).max(80),
  input: z.record(z.string(), z.json()).default({}),
});
export type IntegrationToolCallRequest = z.infer<
  typeof integrationToolCallRequestSchema
>;

export type IntegrationToolCallResponse =
  | { ok: true; output: JsonValue }
  | { ok: false; error: string; retryable: boolean };

export const ToolCallDecision = {
  Approve: "approve",
  Reject: "reject",
} as const;
export type ToolCallDecision =
  (typeof ToolCallDecision)[keyof typeof ToolCallDecision];

export const toolCallDecisionRequestSchema = z.object({
  decision: z.enum(ToolCallDecision),
});
export type ToolCallDecisionRequest = z.infer<
  typeof toolCallDecisionRequestSchema
>;

/** One integration tool call of a run's agents, for the run page. */
export type WorkflowRunToolCall = {
  id: string;
  tool: string;
  /** The provider operation of a write (jira.add_comment); null for reads. */
  operationType: string | null;
  connectionKey: string | null;
  /** The arguments (long texts cut). */
  input: JsonObject;
  status: IntegrationToolCallStatus;
  externalRef: string | null;
  error: string | null;
  /** The instruction action run that called it, or null for a step. */
  actionRunId: string | null;
  /** The process agent step whose loop called it, or null for an instruction. */
  stepId: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

/** The agent tool of each write on the run's source item (`source:` grants). */
export const SOURCE_OPERATION_TOOL: Record<
  SourceOperation,
  IntegrationToolName
> = {
  [SourceOperation.Comment]: IntegrationToolName.SourceItemComment,
  [SourceOperation.Transition]: IntegrationToolName.SourceItemTransition,
  [SourceOperation.Label]: IntegrationToolName.SourceItemLabel,
  [SourceOperation.Link]: IntegrationToolName.SourceItemLink,
};
