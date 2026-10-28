import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@agentflow-ai/loops-api/stable-stringify";
import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationToolCallStatus } from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { trimMessage } from "@/lib/workflows/engine/errors";
import type { AuthenticatedToolSession } from "../integration-tool-session-service";

/**
 * The calls of a session as rows (integration_tool_calls), for the run page
 * and for idempotency: a write is recorded before it runs under a key derived
 * from the session, the tool and its arguments, so an identical repeat finds
 * the first call instead of writing twice. A failed or refused write may be
 * tried again; a succeeded one answers with its first result. A write whose
 * grant requires approval is recorded `pending_approval` with its full
 * arguments (`request`) for the person who decides.
 */

export type StartedCall = { id: string };

export type RepeatedCall =
  | { kind: "succeeded"; externalRef: string | null }
  | { kind: "running" }
  | { kind: "pending_approval" }
  | { kind: "rejected" };

export type CallRecordInput = {
  session: AuthenticatedToolSession;
  tool: string;
  operationType: string | null;
  connectionKey: string | null;
  input: JsonObject;
};

/**
 * Starts a write (or queues it for approval), or reports the identical write
 * that came first.
 */
export async function startWriteCall(
  record: CallRecordInput,
  options: { pendingApproval: boolean } = { pendingApproval: false }
): Promise<Result<StartedCall, RepeatedCall>> {
  const idempotencyKey = hashKey([
    record.session.id,
    record.tool,
    stableStringify(record.input),
  ]);
  try {
    const created = await withDb((db) =>
      db.integrationToolCall.create({
        data: options.pendingApproval
          ? {
              ...rowData(record, idempotencyKey),
              status: IntegrationToolCallStatus.PendingApproval,
              request: record.input,
            }
          : rowData(record, idempotencyKey),
        select: { id: true },
      })
    );
    return Result.ok(created);
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
  }
  return await resumeRepeatedCall(
    idempotencyKey,
    options.pendingApproval ? record.input : null
  );
}

/** Records a read or a refusal, settled at once. */
export async function recordSettledCall(
  record: CallRecordInput,
  outcome: { status: IntegrationToolCallStatus; error?: string }
): Promise<void> {
  await withDb((db) =>
    db.integrationToolCall.create({
      data: {
        ...rowData(record, hashKey([record.session.id, randomUUID()])),
        status: outcome.status,
        error: outcome.error ? trimMessage(outcome.error) : null,
        completedAt: new Date(),
      },
    })
  );
}

export async function finishCall(
  id: string,
  outcome: {
    status: IntegrationToolCallStatus;
    externalRef?: string | null;
    error?: string | null;
  }
): Promise<void> {
  await withDb((db) =>
    db.integrationToolCall.update({
      where: { id },
      data: {
        status: outcome.status,
        externalRef: outcome.externalRef ?? null,
        error: outcome.error ? trimMessage(outcome.error) : null,
        completedAt: new Date(),
      },
    })
  );
}

/**
 * True once the session carried out (or is carrying out, or queued for
 * approval) its write budget.
 */
export async function writeBudgetSpent(
  sessionId: string,
  budget: number
): Promise<boolean> {
  const writes = await withDb((db) =>
    db.integrationToolCall.count({
      where: {
        sessionId,
        operationType: { not: null },
        status: {
          in: [
            IntegrationToolCallStatus.Succeeded,
            IntegrationToolCallStatus.Running,
            IntegrationToolCallStatus.PendingApproval,
          ],
        },
      },
    })
  );
  return writes >= budget;
}

function rowData(record: CallRecordInput, idempotencyKey: string) {
  const { subject } = record.session;
  return {
    organizationId: record.session.organizationId,
    sessionId: record.session.id,
    runId: record.session.runId,
    actionRunId: subject.kind === "instruction" ? subject.actionRunId : null,
    loopId: subject.kind === "step" ? subject.loopId : null,
    tool: record.tool.slice(0, TOOL_NAME_MAX),
    operationType: record.operationType,
    connectionKey: record.connectionKey,
    idempotencyKey,
    input: cutLongTexts(record.input),
    status: IntegrationToolCallStatus.Running,
  };
}

/** `approvalRequest`: the arguments when the retry waits for approval. */
async function resumeRepeatedCall(
  idempotencyKey: string,
  approvalRequest: JsonObject | null
): Promise<Result<StartedCall, RepeatedCall>> {
  const existing = await withDb((db) =>
    db.integrationToolCall.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true, externalRef: true },
    })
  );
  if (!existing || existing.status === IntegrationToolCallStatus.Running) {
    return Result.err({ kind: "running" });
  }
  if (existing.status === IntegrationToolCallStatus.Succeeded) {
    return Result.err({
      kind: "succeeded",
      externalRef: existing.externalRef,
    });
  }
  if (existing.status === IntegrationToolCallStatus.PendingApproval) {
    return Result.err({ kind: "pending_approval" });
  }
  if (existing.status === IntegrationToolCallStatus.Rejected) {
    return Result.err({ kind: "rejected" });
  }
  // A failed or refused attempt: claim it for one more try.
  const claimed = await withDb((db) =>
    db.integrationToolCall.updateMany({
      where: { id: existing.id, status: existing.status },
      data: approvalRequest
        ? {
            status: IntegrationToolCallStatus.PendingApproval,
            request: approvalRequest,
            error: null,
            completedAt: null,
          }
        : {
            status: IntegrationToolCallStatus.Running,
            error: null,
            completedAt: null,
          },
    })
  );
  return claimed.count === 1
    ? Result.ok({ id: existing.id })
    : Result.err({ kind: "running" });
}

const TOOL_NAME_MAX = 80;
const STORED_TEXT_MAX = 4000;

function hashKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Arguments for the run page: texts past STORED_TEXT_MAX are cut. */
function cutLongTexts(input: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "string" && value.length > STORED_TEXT_MAX
        ? `${value.slice(0, STORED_TEXT_MAX)}…`
        : value,
    ])
  );
}
