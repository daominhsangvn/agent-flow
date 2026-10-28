import {
  IntegrationToolCallStatus,
  ToolCallDecision,
  type WorkflowRunToolCall,
} from "@repo/api/src/types/integration-tools";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { trimMessage } from "@/lib/workflows/engine/errors";
import { toJsonObject } from "@/lib/workflows/engine/run-data";
import { integrationToolSessionService } from "./integration-tool-session-service";
import { finishCall } from "./service/call-records";
import { executeWrite } from "./service/execute";
import { loadToolSessionContext } from "./service/session-context";

/**
 * The integration tool calls of a run for the run page, and a person's
 * decision on a call whose grant requires approval (docs/workflows.md
 * "Integration tools"). An approved call is carried out now, through the
 * tools its session has today: a grant removed since refuses it.
 */

export type ToolCallDecisionError = { status: StatusCode; message: string };

export const integrationToolCallService = {
  async listForRun(
    organizationId: string,
    runId: string
  ): Promise<WorkflowRunToolCall[]> {
    const calls = await withDb((db) =>
      db.integrationToolCall.findMany({
        where: { runId, organizationId },
        orderBy: { createdAt: "asc" },
        take: RUN_CALLS_MAX,
        select: {
          id: true,
          tool: true,
          operationType: true,
          connectionKey: true,
          input: true,
          status: true,
          externalRef: true,
          error: true,
          actionRunId: true,
          decidedById: true,
          decidedAt: true,
          createdAt: true,
          session: { select: { stepId: true } },
        },
      })
    );
    const deciders = await loadUserNames(
      organizationId,
      calls.flatMap((call) => (call.decidedById ? [call.decidedById] : []))
    );
    return calls.map((call) => ({
      id: call.id,
      tool: call.tool,
      operationType: call.operationType,
      connectionKey: call.connectionKey,
      input: toJsonObject(call.input),
      status: toCallStatus(call.status),
      externalRef: call.externalRef,
      error: call.error,
      actionRunId: call.actionRunId,
      stepId: call.session.stepId,
      decidedBy: call.decidedById
        ? (deciders.get(call.decidedById) ?? null)
        : null,
      decidedAt: call.decidedAt,
      createdAt: call.createdAt,
    }));
  },

  /**
   * Approves (carries out) or rejects a call waiting for approval. NotFound
   * for another run's call, Conflict once it was decided.
   */
  async decide(input: {
    organizationId: string;
    runId: string;
    callId: string;
    decision: ToolCallDecision;
    userId: string;
  }): Promise<Result<void, ToolCallDecisionError>> {
    const approve = input.decision === ToolCallDecision.Approve;
    const now = new Date();
    const [claimed] = await withDb((db) =>
      db.integrationToolCall.updateManyAndReturn({
        where: {
          id: input.callId,
          runId: input.runId,
          organizationId: input.organizationId,
          status: IntegrationToolCallStatus.PendingApproval,
        },
        data: approve
          ? {
              status: IntegrationToolCallStatus.Running,
              decidedById: input.userId,
              decidedAt: now,
            }
          : {
              status: IntegrationToolCallStatus.Rejected,
              decidedById: input.userId,
              decidedAt: now,
              completedAt: now,
            },
        select: { id: true, sessionId: true, tool: true, request: true },
      })
    );
    if (!claimed) {
      return await decisionRefusal(input);
    }
    if (approve) {
      await carryOutApproved(input.organizationId, claimed);
    }
    return Result.ok(undefined);
  },
};

const RUN_CALLS_MAX = 200;

/** Runs the approved call through the tools its session has now. */
async function carryOutApproved(
  organizationId: string,
  call: { id: string; sessionId: string; tool: string; request: unknown }
): Promise<void> {
  const fail = (error: string) =>
    finishCall(call.id, {
      status: IntegrationToolCallStatus.Failed,
      error,
    });
  const session = await integrationToolSessionService.find(
    organizationId,
    call.sessionId
  );
  const context = session ? await loadToolSessionContext(session) : null;
  if (!context) {
    await fail("The run or its agent's grant no longer exists.");
    return;
  }
  const tool = context.tools.find((candidate) => candidate.name === call.tool);
  const plan = tool?.plan(toJsonObject(call.request));
  if (
    !(
      plan?.ok &&
      (plan.value.kind === "write" || plan.value.kind === "pull_request_write")
    )
  ) {
    await fail(
      plan && !plan.ok
        ? plan.error
        : `${call.tool} is no longer granted to this agent.`
    );
    return;
  }
  const outcome = await executeWrite(context, plan.value, call.id);
  await finishCall(call.id, {
    status: outcome.ok
      ? IntegrationToolCallStatus.Succeeded
      : IntegrationToolCallStatus.Failed,
    externalRef: outcome.ok ? outcome.externalRef : null,
    error: outcome.ok ? null : trimMessage(outcome.error),
  });
}

async function decisionRefusal(input: {
  organizationId: string;
  runId: string;
  callId: string;
}): Promise<Result<void, ToolCallDecisionError>> {
  const existing = await withDb((db) =>
    db.integrationToolCall.findFirst({
      where: {
        id: input.callId,
        runId: input.runId,
        organizationId: input.organizationId,
      },
      select: { id: true },
    })
  );
  return Result.err(
    existing
      ? {
          status: Status.Conflict,
          message: "This call is not waiting for approval anymore.",
        }
      : { status: Status.NotFound, message: "Tool call not found" }
  );
}

async function loadUserNames(
  organizationId: string,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const users = await withDb((db) =>
    db.user.findMany({
      where: { id: { in: [...new Set(ids)] }, organizationId },
      select: { id: true, email: true, firstName: true, lastName: true },
    })
  );
  return new Map(
    users.map((user) => [
      user.id,
      [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
    ])
  );
}

const CALL_STATUSES: readonly string[] = Object.values(
  IntegrationToolCallStatus
);

function toCallStatus(value: string): IntegrationToolCallStatus {
  return CALL_STATUSES.includes(value)
    ? (value as IntegrationToolCallStatus)
    : IntegrationToolCallStatus.Failed;
}
