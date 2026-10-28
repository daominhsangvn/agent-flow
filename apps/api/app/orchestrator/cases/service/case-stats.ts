import { withDb } from "@repo/database";
import { readTurnUsage } from "@/app/orchestrator/cases/case-mappers";

/**
 * Per-case task and turn counts and cost for the case list and page: three
 * bounded queries for all asked cases, no per-case fan-out.
 */

export type CaseStats = {
  taskCount: number;
  turnCount: number;
  /** Known turn + task loop cost; null when none is known. */
  costUsd: number | null;
};

type TurnRow = { usage: unknown; conversation: { caseId: string } };
type TaskRow = { caseId: string; loopId: string | null };

export async function loadCaseStats(
  organizationId: string,
  caseIds: string[]
): Promise<Map<string, CaseStats>> {
  if (caseIds.length === 0) {
    return new Map();
  }
  const [turns, tasks] = await Promise.all([
    withDb((db) =>
      db.orchestratorTurn.findMany({
        where: { organizationId, conversation: { caseId: { in: caseIds } } },
        select: { usage: true, conversation: { select: { caseId: true } } },
      })
    ),
    withDb((db) =>
      db.orchestratorTask.findMany({
        where: { organizationId, caseId: { in: caseIds } },
        select: { caseId: true, loopId: true },
      })
    ),
  ]);
  const loopIds = [
    ...new Set(
      tasks.flatMap((task) => (task.loopId === null ? [] : [task.loopId]))
    ),
  ];
  const loopCostById = new Map<string, number | null>();
  if (loopIds.length > 0) {
    const loops = await withDb((db) =>
      db.loop.findMany({
        where: { organizationId, id: { in: loopIds } },
        select: { id: true, estimatedCost: true },
      })
    );
    for (const loop of loops) {
      loopCostById.set(
        loop.id,
        loop.estimatedCost === null ? null : Number(loop.estimatedCost)
      );
    }
  }
  return foldCaseStats(caseIds, turns, tasks, loopCostById);
}

export function foldCaseStats(
  caseIds: string[],
  turns: TurnRow[],
  tasks: TaskRow[],
  loopCostById: Map<string, number | null>
): Map<string, CaseStats> {
  const stats = new Map<string, CaseStats>();
  for (const id of caseIds) {
    stats.set(id, { taskCount: 0, turnCount: 0, costUsd: null });
  }
  for (const turn of turns) {
    const current = stats.get(turn.conversation.caseId);
    if (current) {
      current.turnCount += 1;
      current.costUsd = addCost(
        current.costUsd,
        readTurnUsage(turn.usage)?.costUsd ?? null
      );
    }
  }
  for (const task of tasks) {
    const current = stats.get(task.caseId);
    if (current) {
      current.taskCount += 1;
      current.costUsd = addCost(
        current.costUsd,
        task.loopId === null ? null : (loopCostById.get(task.loopId) ?? null)
      );
    }
  }
  return stats;
}

function addCost(total: number | null, part: number | null): number | null {
  if (part === null) {
    return total;
  }
  return (total ?? 0) + part;
}
