import type {
  OrchestratorCaseConversation,
  OrchestratorCaseDecision,
  OrchestratorCaseDetail,
  OrchestratorCaseMessage,
  OrchestratorCaseSummary,
  OrchestratorCaseTask,
  OrchestratorCaseTurn,
  OrchestratorCaseWait,
  OrchestratorConversationStatus,
  OrchestratorDecisionStatus,
  OrchestratorDecisionVia,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
  OrchestratorTaskStatus,
  OrchestratorTurnEnd,
  OrchestratorTurnStatus,
  OrchestratorTurnUsage,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import { OrchestratorCaseStatus } from "@repo/api/src/types/orchestrator";
import { z } from "zod";
import type { CaseStats } from "@/app/orchestrator/cases/service/case-stats";
import { readTaskResult } from "@/lib/orchestrator/task-result";

/**
 * Rows of the orchestrator tables as the case API returns them (pure: dates
 * as ISO strings, JSON columns parsed, newest-first selections turned
 * oldest-first).
 */

type Row = {
  id: string;
  createdAt: Date;
};

export type CaseSummaryRow = Row & {
  projectId: string;
  workflowId: string;
  title: string;
  sourceKey: string | null;
  status: string;
  updatedAt: Date;
  _count: { conversations: number; decisions: number; tasks: number };
};

export type CaseDetailRow = CaseSummaryRow & {
  notes: string;
  project: { id: string; name: string };
  workflow: { id: string; name: string };
  conversations: Array<
    Row & {
      channelKey: string;
      status: string;
      messages: Array<
        Row & {
          conversationId: string;
          origin: string;
          kind: string;
          actor: string | null;
          text: string;
          turnId: string | null;
        }
      >;
      turns: Array<
        Row & {
          conversationId: string;
          status: string;
          ended: string | null;
          summary: string | null;
          error: string | null;
          usage: unknown;
          startedAt: Date;
          finishedAt: Date | null;
          computeTarget: { machineName: string } | null;
        }
      >;
      waits: Array<
        Row & {
          conversationId: string;
          kind: string;
          taskIds: unknown;
          deadline: Date | null;
          wakeOnFailure: boolean;
          firedAt: Date | null;
        }
      >;
    }
  >;
  tasks: Array<
    Row & {
      conversationId: string;
      turnId: string | null;
      command: string;
      args: string;
      prompt: string;
      mode: string;
      computeTargetId: string | null;
      computeTarget: { machineName: string } | null;
      status: string;
      fork: boolean;
      resumeTaskId: string | null;
      loopId: string | null;
      result: unknown;
      finishedAt: Date | null;
    }
  >;
  decisions: Array<
    Row & {
      conversationId: string;
      question: string;
      status: string;
      via: string | null;
      decidedBy: string | null;
      comment: string | null;
      decidedAt: Date | null;
    }
  >;
};

export function toCaseSummary(
  row: CaseSummaryRow,
  turnRunning: boolean,
  stats: CaseStats
): OrchestratorCaseSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    workflowId: row.workflowId,
    title: row.title,
    sourceKey: row.sourceKey,
    status: toCaseStatus(row.status),
    conversationCount: row._count.conversations,
    pendingDecisionCount: row._count.decisions,
    activeTaskCount: row._count.tasks,
    turnRunning,
    taskCount: stats.taskCount,
    turnCount: stats.turnCount,
    costUsd: stats.costUsd,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCaseDetail(
  row: CaseDetailRow,
  turnRunning: boolean,
  stats: CaseStats
): OrchestratorCaseDetail {
  return {
    ...toCaseSummary(row, turnRunning, stats),
    notes: row.notes,
    project: row.project,
    workflow: row.workflow,
    conversations: row.conversations.map(toConversation),
    tasks: oldestFirst(row.tasks).map(toTask),
    waits: oldestFirst(row.conversations.flatMap((c) => c.waits)).map(toWait),
    decisions: oldestFirst(row.decisions).map(toDecision),
  };
}

/** Running turns keep `{ timeoutMs }` only: no cost or tokens yet. */
export function readTurnUsage(value: unknown): OrchestratorTurnUsage | null {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { costUsd, inputTokens, outputTokens } = parsed.data;
  if (
    costUsd === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined
  ) {
    return null;
  }
  return {
    costUsd: costUsd ?? null,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
  };
}

const usageSchema = z.object({
  costUsd: z.number().nullable().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
});

const taskIdsSchema = z.array(z.string()).catch([]);

function toCaseStatus(value: string): OrchestratorCaseStatus {
  return value === OrchestratorCaseStatus.Closed
    ? OrchestratorCaseStatus.Closed
    : OrchestratorCaseStatus.Open;
}

/** Selections are newest-first and bounded; the API returns oldest-first. */
function oldestFirst<T>(rows: T[]): T[] {
  return [...rows].reverse();
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toConversation(
  row: CaseDetailRow["conversations"][number]
): OrchestratorCaseConversation {
  return {
    id: row.id,
    channelKey: row.channelKey,
    status: row.status as OrchestratorConversationStatus,
    createdAt: row.createdAt.toISOString(),
    messages: oldestFirst(row.messages).map(toMessage),
    turns: oldestFirst(row.turns).map(toTurn),
  };
}

function toMessage(
  row: CaseDetailRow["conversations"][number]["messages"][number]
): OrchestratorCaseMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    origin: row.origin as OrchestratorMessageOrigin,
    kind: row.kind as OrchestratorMessageKind,
    actor: row.actor,
    text: row.text,
    turnId: row.turnId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTurn(
  row: CaseDetailRow["conversations"][number]["turns"][number]
): OrchestratorCaseTurn {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status as OrchestratorTurnStatus,
    ended: row.ended as OrchestratorTurnEnd | null,
    summary: row.summary,
    error: row.error,
    usage: readTurnUsage(row.usage),
    runnerName: row.computeTarget?.machineName ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

function toTask(row: CaseDetailRow["tasks"][number]): OrchestratorCaseTask {
  const result = readTaskResult(row.result);
  return {
    id: row.id,
    conversationId: row.conversationId,
    turnId: row.turnId,
    command: row.command,
    args: row.args,
    prompt: row.prompt,
    mode: row.mode,
    runnerName: row.computeTarget?.machineName ?? null,
    computeTargetId: row.computeTargetId,
    status: row.status as OrchestratorTaskStatus,
    fork: row.fork,
    resumeTaskId: row.resumeTaskId,
    loopId: row.loopId,
    reply: result?.reply ?? null,
    files: (result?.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      stored: file.storageKey !== null,
      skipped: file.skipped,
    })),
    filesOmitted: result?.filesOmitted ?? 0,
    questions: result?.questions ?? [],
    error: result?.error ?? cancelledError(result),
    waiting: result?.waiting ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

function toWait(
  row: CaseDetailRow["conversations"][number]["waits"][number]
): OrchestratorCaseWait {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind as OrchestratorWaitKind,
    taskIds: taskIdsSchema.parse(row.taskIds),
    deadline: iso(row.deadline),
    wakeOnFailure: row.wakeOnFailure,
    firedAt: iso(row.firedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toDecision(
  row: CaseDetailRow["decisions"][number]
): OrchestratorCaseDecision {
  return {
    id: row.id,
    conversationId: row.conversationId,
    question: row.question,
    status: row.status as OrchestratorDecisionStatus,
    via: row.via as OrchestratorDecisionVia | null,
    decidedBy: row.decidedBy,
    comment: row.comment,
    decidedAt: iso(row.decidedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function cancelledError(
  result: ReturnType<typeof readTaskResult>
): string | null {
  return result?.cancelled ? `Cancelled: ${result.cancelled}` : null;
}
