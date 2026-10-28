import type { WorkflowRunSession } from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { projectDisplayedSessionStatus } from "@/app/agent-sessions/service/session-status-projection";
import type { RunLoopState } from "./engine/run-loops";

/**
 * Agent sessions the run's loops ran, newest first. The desktop attributes a
 * session to the loop that launched it (`SessionDetail.sourceLoopId`), so the
 * run's loops are the join; sessions of another organization are dropped.
 * The status is the one the Sessions list displays (waiting / stale folds).
 */
export async function listRunSessions(
  organizationId: string,
  loops: readonly Pick<RunLoopState, "loopId" | "command" | "stepId">[]
): Promise<WorkflowRunSession[]> {
  if (loops.length === 0) {
    return [];
  }
  const loopsById = new Map(loops.map((loop) => [loop.loopId, loop]));
  const rows = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        sourceLoopId: { in: [...loopsById.keys()] },
        artifact: { is: { organizationId } },
      },
      orderBy: [{ sessionStartedAt: "desc" }, { artifactId: "desc" }],
      select: RUN_SESSION_SELECT,
    })
  );
  const now = new Date();
  return rows.flatMap((row) => {
    const loop = row.sourceLoopId ? loopsById.get(row.sourceLoopId) : undefined;
    if (!loop) {
      return [];
    }
    return [
      {
        id: row.artifactId,
        slug: row.artifact.slug,
        name: row.artifact.name,
        loopId: loop.loopId,
        command: loop.command,
        stepId: loop.stepId,
        status: projectDisplayedSessionStatus(
          {
            status: row.artifact.status,
            awaitingInputSince: row.awaitingInputSince,
            sessionEndedAt: row.sessionEndedAt,
            lastActivityAt: row.lastActivityAt,
            sessionStartedAt: row.sessionStartedAt,
          },
          now
        ),
        harness: row.harness,
        model: row.model,
        startedAt: row.sessionStartedAt,
        lastActivityAt: row.lastActivityAt,
        endedAt: row.sessionEndedAt,
      },
    ];
  });
}

const RUN_SESSION_SELECT = {
  artifactId: true,
  sourceLoopId: true,
  harness: true,
  model: true,
  sessionStartedAt: true,
  lastActivityAt: true,
  sessionEndedAt: true,
  awaitingInputSince: true,
  artifact: { select: { slug: true, name: true, status: true } },
} as const;
