import type { OrchestratorCaseLoops } from "@repo/api/src/types/orchestrator";
import type {
  WorkflowRunLoopRef,
  WorkflowRunPullRequest,
} from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { z } from "zod";
import { listRunSessions } from "@/lib/workflows/run-sessions";

/**
 * The loops the tasks of a case ran, with their sessions and pull requests
 * (the case page's Agent loops, Sessions and Work items cards).
 */

const TASKS_MAX = 200;

const repoSchema = z.object({ fullName: z.string() });

type TaskRef = { command: string; loopId: string | null };
type LoopRow = {
  id: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  repo: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
};

export async function loadCaseLoops(
  organizationId: string,
  caseId: string
): Promise<OrchestratorCaseLoops> {
  const tasks = await withDb((db) =>
    db.orchestratorTask.findMany({
      where: { organizationId, caseId, loopId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: TASKS_MAX,
      select: { command: true, loopId: true },
    })
  );
  const loopIds = [
    ...new Set(
      tasks.flatMap((task) => (task.loopId === null ? [] : [task.loopId]))
    ),
  ];
  if (loopIds.length === 0) {
    return { loops: [], sessions: [], pullRequests: [] };
  }
  const rows = await withDb((db) =>
    db.loop.findMany({
      where: { organizationId, id: { in: loopIds } },
      select: {
        id: true,
        status: true,
        prUrl: true,
        prNumber: true,
        branchName: true,
        repo: true,
        startedAt: true,
        completedAt: true,
      },
    })
  );
  const { loops, pullRequests } = toCaseLoops(tasks, rows);
  const sessions = await listRunSessions(
    organizationId,
    loops.map(({ loopId, command }) => ({ loopId, command, stepId: null }))
  );
  return { loops, sessions, pullRequests };
}

export function toCaseLoops(
  tasks: TaskRef[],
  rows: LoopRow[]
): Pick<OrchestratorCaseLoops, "loops" | "pullRequests"> {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const loops: WorkflowRunLoopRef[] = [];
  const pullRequests = new Map<string, WorkflowRunPullRequest>();
  for (const task of tasks) {
    const row = task.loopId === null ? undefined : rowById.get(task.loopId);
    if (!row) {
      continue;
    }
    loops.push({
      loopId: row.id,
      command: task.command,
      status: row.status,
      adopted: false,
      stepId: null,
      prUrl: row.prUrl,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
    if (row.prUrl !== null && !pullRequests.has(row.prUrl)) {
      pullRequests.set(row.prUrl, {
        url: row.prUrl,
        number: row.prNumber,
        repository: repoSchema.safeParse(row.repo).data?.fullName ?? null,
        branch: row.branchName,
      });
    }
  }
  return { loops, pullRequests: [...pullRequests.values()] };
}
