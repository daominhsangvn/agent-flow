import { OrchestratorCaseStatus } from "@repo/api/src/types/orchestrator";
import type { WorkflowCaseCounts } from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";

/**
 * Case counts of orchestrated workflows (they have no workflow runs): one
 * grouped query for all asked workflows.
 */

export type CaseCountsByWorkflow = Map<string, WorkflowCaseCounts>;

export type CaseGroup = {
  status: string;
  _count: { _all: number };
  _max: { updatedAt: Date | null };
};

export async function loadCaseCounts(
  organizationId: string,
  workflowIds: string[]
): Promise<CaseCountsByWorkflow> {
  const counts: CaseCountsByWorkflow = new Map();
  if (workflowIds.length === 0) {
    return counts;
  }
  const groups = await withDb((db) =>
    db.orchestratorCase.groupBy({
      by: ["workflowId", "status"],
      where: { organizationId, workflowId: { in: workflowIds } },
      _count: { _all: true },
      _max: { updatedAt: true },
    })
  );
  for (const id of workflowIds) {
    counts.set(id, emptyCaseCounts());
  }
  for (const group of groups) {
    const current = counts.get(group.workflowId) ?? emptyCaseCounts();
    counts.set(group.workflowId, addCaseGroup(current, group));
  }
  return counts;
}

export function addCaseGroup(
  counts: WorkflowCaseCounts,
  group: CaseGroup
): WorkflowCaseCounts {
  const amount = group._count._all;
  const isClosed = group.status === OrchestratorCaseStatus.Closed;
  return {
    total: counts.total + amount,
    open: counts.open + (isClosed ? 0 : amount),
    closed: counts.closed + (isClosed ? amount : 0),
    lastActivityAt: laterDate(counts.lastActivityAt, group._max.updatedAt),
  };
}

function emptyCaseCounts(): WorkflowCaseCounts {
  return { total: 0, open: 0, closed: 0, lastActivityAt: null };
}

function laterDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}
