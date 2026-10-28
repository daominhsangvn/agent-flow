import type { JsonObject } from "@repo/api/src/types/common";
import { PULL_REQUESTS_CONNECTION_KEY } from "@repo/api/src/types/connection-grants";
import {
  type IntegrationToolCallRequest,
  type IntegrationToolCallResponse,
  IntegrationToolCallStatus,
  type IntegrationToolSessionDescriptor,
} from "@repo/api/src/types/integration-tools";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type AgentTool,
  describeAgentToolSession,
  type PlannedToolCall,
} from "@/lib/integrations/agent-tools/catalog";
import { integrationToolSessionService } from "./integration-tool-session-service";
import { attachSourceFile, type FileUpload } from "./service/attachments";
import {
  type CallRecordInput,
  finishCall,
  type RepeatedCall,
  recordSettledCall,
  startWriteCall,
  writeBudgetSpent,
} from "./service/call-records";
import {
  type ExecutionOutcome,
  executeWrite,
  readConnectionItem,
  readOperation,
  readSourceAttachment,
  readSourceItem,
  type WritePlan,
} from "./service/execute";
import {
  listRunPullRequests,
  readPullRequestThreads,
} from "./service/pull-requests";
import {
  loadToolSessionContext,
  type ToolSessionContext,
} from "./service/session-context";

/**
 * The integration tools an instruction's agent calls through the MCP server
 * (docs/workflows.md "Integration tools"). Every request authenticates its
 * session token and recomputes the session's tools from the instruction's
 * grant, so nothing the agent sends can widen them: an unknown tool, a key
 * outside the grant or arguments the operation rejects are refused before
 * anything reaches the provider. Every call is recorded for the run page.
 */
export const integrationToolService = {
  async describe(
    token: string | null
  ): Promise<Result<IntegrationToolSessionDescriptor, StatusCode>> {
    const context = await loadContext(token);
    if (!context.ok) {
      return context;
    }
    const { input, tools } = context.value;
    return Result.ok({
      instructions: describeAgentToolSession(input, tools),
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    });
  },

  async call(
    token: string | null,
    request: IntegrationToolCallRequest
  ): Promise<Result<IntegrationToolCallResponse, StatusCode>> {
    const context = await loadContext(token);
    if (!context.ok) {
      return context;
    }
    return Result.ok(await callTool(context.value, request));
  },

  /** A file the agent attaches to the run's source item for a comment. */
  async attach(
    token: string | null,
    upload: FileUpload
  ): Promise<Result<IntegrationToolCallResponse, StatusCode>> {
    const context = await loadContext(token);
    if (!context.ok) {
      return context;
    }
    return Result.ok(await attachSourceFile(context.value, upload));
  },
};

async function loadContext(
  token: string | null
): Promise<Result<ToolSessionContext, StatusCode>> {
  const session = await integrationToolSessionService.authenticate(token);
  if (!session) {
    return Result.err(Status.Unauthorized);
  }
  const context = await loadToolSessionContext(session);
  return context ? Result.ok(context) : Result.err(Status.NotFound);
}

async function callTool(
  context: ToolSessionContext,
  request: IntegrationToolCallRequest
): Promise<IntegrationToolCallResponse> {
  const tool = context.tools.find(
    (candidate) => candidate.name === request.tool
  );
  const record: CallRecordInput = {
    session: context.session,
    tool: request.tool,
    operationType: tool?.operationType ?? null,
    connectionKey: callConnectionKey(context, request.input),
    input: request.input,
  };
  if (!tool) {
    return await refuse(
      record,
      `There is no tool "${request.tool}" in this session. Tools: ${context.tools.map((candidate) => candidate.name).join(", ")}.`
    );
  }
  const plan = tool.plan(request.input);
  if (!plan.ok) {
    return await refuse(record, plan.error);
  }
  return await runPlan(context, tool, plan.value, record);
}

async function runPlan(
  context: ToolSessionContext,
  tool: AgentTool,
  plan: PlannedToolCall,
  record: CallRecordInput
): Promise<IntegrationToolCallResponse> {
  if (plan.kind === "overview") {
    await recordSettledCall(record, {
      status: IntegrationToolCallStatus.Succeeded,
    });
    return {
      ok: true,
      output: describeAgentToolSession(context.input, context.tools),
    };
  }
  if (plan.kind === "write" || plan.kind === "pull_request_write") {
    return await runWrite(context, tool, plan, {
      ...record,
      connectionKey: writeConnectionKey(context, plan),
    });
  }
  const read = await runRead(context, plan);
  await recordSettledCall(
    read.connectionKey === undefined
      ? record
      : { ...record, connectionKey: read.connectionKey },
    {
      status: read.outcome.ok
        ? IntegrationToolCallStatus.Succeeded
        : IntegrationToolCallStatus.Failed,
      error: read.outcome.ok ? undefined : read.outcome.error,
    }
  );
  return read.outcome.ok
    ? { ok: true, output: read.outcome.output }
    : {
        ok: false,
        error: read.outcome.error,
        retryable: read.outcome.retryable,
      };
}

/** A planned call that only reads. */
type ReadPlan = Exclude<
  PlannedToolCall,
  { kind: "overview" } | { kind: "write" } | { kind: "pull_request_write" }
>;

/** Carries out a read; `connectionKey` (when set) is what it is recorded under. */
async function runRead(
  context: ToolSessionContext,
  plan: ReadPlan
): Promise<{ outcome: ExecutionOutcome; connectionKey?: string }> {
  switch (plan.kind) {
    case "read_source":
      return { outcome: await readSourceItem(context) };
    case "read_source_attachment":
      return { outcome: await readSourceAttachment(context, plan) };
    case "read_item":
      return {
        outcome: await readConnectionItem(context, plan),
        connectionKey: plan.connection.key,
      };
    case "read_operation":
      return {
        outcome: await readOperation(context, plan),
        connectionKey: plan.connection.key,
      };
    case "pull_requests":
      return {
        outcome: await listRunPullRequests(context),
        connectionKey: PULL_REQUESTS_CONNECTION_KEY,
      };
    default:
      return {
        outcome: await readPullRequestThreads(context, plan),
        connectionKey: PULL_REQUESTS_CONNECTION_KEY,
      };
  }
}
/** The key a write is recorded under. */
function writeConnectionKey(
  context: ToolSessionContext,
  plan: WritePlan
): string | null {
  if (plan.kind === "pull_request_write") {
    return PULL_REQUESTS_CONNECTION_KEY;
  }
  return plan.connection?.key ?? context.input.source.key;
}

async function runWrite(
  context: ToolSessionContext,
  tool: AgentTool,
  plan: WritePlan,
  record: CallRecordInput
): Promise<IntegrationToolCallResponse> {
  if (await writeBudgetSpent(context.session.id, context.writeBudget)) {
    return await refuse(
      record,
      `This session already carried out its ${context.writeBudget} writes; stop here and say what is left in your answer.`
    );
  }
  const started = await startWriteCall(record, {
    pendingApproval: plan.requiresApproval,
  });
  if (!started.ok) {
    return repeatedCallResponse(tool, started.error);
  }
  if (plan.requiresApproval) {
    return { ok: true, output: PENDING_APPROVAL_OUTPUT };
  }
  const outcome = await executeWrite(context, plan, started.value.id);
  await finishCall(started.value.id, {
    status: outcome.ok
      ? IntegrationToolCallStatus.Succeeded
      : IntegrationToolCallStatus.Failed,
    externalRef: outcome.ok ? outcome.externalRef : null,
    error: outcome.ok ? null : outcome.error,
  });
  return outcome.ok
    ? { ok: true, output: outcome.output }
    : { ok: false, error: outcome.error, retryable: outcome.retryable };
}

const PENDING_APPROVAL_OUTPUT = {
  status: IntegrationToolCallStatus.PendingApproval,
  message:
    "Queued for a person's approval on the run page; it is carried out once approved. Do not call it again; continue and mention it in your answer.",
};

/** What an identical repeat of an earlier write answers. */
function repeatedCallResponse(
  tool: AgentTool,
  repeated: RepeatedCall
): IntegrationToolCallResponse {
  switch (repeated.kind) {
    case "succeeded":
      return {
        ok: true,
        output: {
          done: true,
          reference: repeated.externalRef,
          repeated: `This identical ${tool.name} call already succeeded; it was not carried out again.`,
        },
      };
    case "pending_approval":
      return { ok: true, output: PENDING_APPROVAL_OUTPUT };
    case "rejected":
      return {
        ok: false,
        error: `A person rejected this identical ${tool.name} call; do not try it again.`,
        retryable: false,
      };
    default:
      return {
        ok: false,
        error: `An identical ${tool.name} call is still running.`,
        retryable: true,
      };
  }
}

async function refuse(
  record: CallRecordInput,
  error: string
): Promise<IntegrationToolCallResponse> {
  await recordSettledCall(record, {
    status: IntegrationToolCallStatus.Refused,
    error,
  });
  return { ok: false, error: `Not allowed: ${error}`, retryable: false };
}

/** The key a call names, for the record: its `connection` argument if any. */
function callConnectionKey(
  context: ToolSessionContext,
  input: JsonObject
): string | null {
  return typeof input.connection === "string"
    ? input.connection.slice(0, CONNECTION_KEY_MAX)
    : context.input.source.key;
}

const CONNECTION_KEY_MAX = 40;
