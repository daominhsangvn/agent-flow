import {
  type OrchestratorCaseDetail,
  type OrchestratorCaseSummary,
  OrchestratorDecisionStatus,
  OrchestratorTaskStatus,
  OrchestratorTurnStatus,
  type UpdateOrchestratorCaseInput,
} from "@repo/api/src/types/orchestrator";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import {
  toCaseDetail,
  toCaseSummary,
} from "@/app/orchestrator/cases/case-mappers";
import { dispatchOrchestratorTurnCancel } from "@/lib/loops/loop-desktop";
import { readTurnTimeoutMs } from "@/lib/orchestrator/turn-usage";
import { displayUserName } from "@/lib/user-display-name";

/**
 * What the case pages read and the admin actions on them
 * (docs/orchestrator.md). Reads are bounded: the 100 most recently updated
 * cases of a workflow; per case the newest messages, turns, tasks, waits and
 * decisions.
 */

const CASES_MAX = 100;
const MESSAGES_MAX = 200;
const TURNS_MAX = 100;
const TASKS_MAX = 200;
const WAITS_MAX = 100;
const DECISIONS_MAX = 100;

export const orchestratorCaseService = {
  /** Null when the organization has no such workflow. */
  async listForWorkflow(
    organizationId: string,
    workflowId: string
  ): Promise<OrchestratorCaseSummary[] | null> {
    const workflow = await withDb((db) =>
      db.workflow.findFirst({
        where: { id: workflowId, organizationId },
        select: { id: true },
      })
    );
    if (!workflow) {
      return null;
    }
    const rows = await withDb((db) =>
      db.orchestratorCase.findMany({
        where: { organizationId, workflowId },
        orderBy: { updatedAt: "desc" },
        take: CASES_MAX,
        select: {
          id: true,
          projectId: true,
          workflowId: true,
          title: true,
          sourceKey: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              conversations: true,
              decisions: {
                where: { status: OrchestratorDecisionStatus.Pending },
              },
              tasks: {
                where: {
                  status: {
                    in: [
                      OrchestratorTaskStatus.Queued,
                      OrchestratorTaskStatus.Running,
                    ],
                  },
                },
              },
            },
          },
        },
      })
    );
    const running = await runningCaseIds(
      organizationId,
      rows.map((row) => row.id)
    );
    return rows.map((row) => toCaseSummary(row, running.has(row.id)));
  },

  async get(
    organizationId: string,
    caseId: string
  ): Promise<OrchestratorCaseDetail | null> {
    const row = await withDb((db) =>
      db.orchestratorCase.findFirst({
        where: { id: caseId, organizationId },
        include: {
          project: { select: { id: true, name: true } },
          workflow: { select: { id: true, name: true } },
          conversations: {
            orderBy: { createdAt: "asc" },
            include: {
              messages: { orderBy: { createdAt: "desc" }, take: MESSAGES_MAX },
              turns: {
                orderBy: { startedAt: "desc" },
                take: TURNS_MAX,
                include: { computeTarget: { select: { machineName: true } } },
              },
              waits: { orderBy: { createdAt: "desc" }, take: WAITS_MAX },
            },
          },
          tasks: {
            orderBy: { createdAt: "desc" },
            take: TASKS_MAX,
            include: { computeTarget: { select: { machineName: true } } },
          },
          decisions: { orderBy: { createdAt: "desc" }, take: DECISIONS_MAX },
          _count: {
            select: {
              conversations: true,
              decisions: {
                where: { status: OrchestratorDecisionStatus.Pending },
              },
              tasks: {
                where: {
                  status: {
                    in: [
                      OrchestratorTaskStatus.Queued,
                      OrchestratorTaskStatus.Running,
                    ],
                  },
                },
              },
            },
          },
        },
      })
    );
    if (!row) {
      return null;
    }
    const running = await runningCaseIds(organizationId, [row.id]);
    return toCaseDetail(row, running.has(row.id));
  },

  /** Close or reopen a case. Only the status changes. */
  async setStatus(
    organizationId: string,
    caseId: string,
    input: UpdateOrchestratorCaseInput
  ): Promise<
    Result<{ status: UpdateOrchestratorCaseInput["status"] }, StatusCode>
  > {
    const updated = await withDb((db) =>
      db.orchestratorCase.updateMany({
        where: { id: caseId, organizationId },
        data: { status: input.status },
      })
    );
    if (updated.count === 0) {
      return Result.err(Status.NotFound);
    }
    return Result.ok({ status: input.status });
  },

  /**
   * Stops a running turn: marks it (so it settles as failed, "Stopped by
   * <admin>.", without a retry) and asks its runner to stop it.
   */
  async cancelTurn(
    organizationId: string,
    userId: string,
    turnId: string
  ): Promise<Result<{ turnId: string }, StatusCode>> {
    const turn = await withDb((db) =>
      db.orchestratorTurn.findFirst({
        where: {
          id: turnId,
          organizationId,
          status: OrchestratorTurnStatus.Running,
        },
        select: { id: true, computeTargetId: true, usage: true },
      })
    );
    if (!turn) {
      return Result.err(Status.NotFound);
    }
    if (!turn.computeTargetId) {
      return Result.err(Status.BadRequest);
    }
    const user = await withDb((db) =>
      db.user.findFirst({
        where: { id: userId, organizationId },
        select: { firstName: true, lastName: true, email: true },
      })
    );
    if (!user) {
      return Result.err(Status.Forbidden);
    }
    // Conditional on still running: a turn that settled meanwhile keeps its
    // real usage and is not cancelled.
    const marked = await withDb((db) =>
      db.orchestratorTurn.updateMany({
        where: {
          id: turn.id,
          organizationId,
          status: OrchestratorTurnStatus.Running,
        },
        data: {
          usage: {
            timeoutMs: readTurnTimeoutMs(turn.usage),
            cancelRequestedAt: new Date().toISOString(),
            cancelledBy: displayUserName(user),
          },
        },
      })
    );
    if (marked.count === 0) {
      return Result.err(Status.NotFound);
    }
    try {
      await dispatchOrchestratorTurnCancel({
        computeTargetId: turn.computeTargetId,
        turnId: turn.id,
      });
    } catch {
      return Result.err(Status.BadGateway);
    }
    return Result.ok({ turnId: turn.id });
  },
};

/** The cases (of those asked) with a running turn: one query, no fan-out. */
async function runningCaseIds(
  organizationId: string,
  caseIds: string[]
): Promise<Set<string>> {
  if (caseIds.length === 0) {
    return new Set();
  }
  const turns = await withDb((db) =>
    db.orchestratorTurn.findMany({
      where: {
        organizationId,
        status: OrchestratorTurnStatus.Running,
        conversation: { caseId: { in: caseIds } },
      },
      select: { conversation: { select: { caseId: true } } },
    })
  );
  return new Set(turns.map((turn) => turn.conversation.caseId));
}
