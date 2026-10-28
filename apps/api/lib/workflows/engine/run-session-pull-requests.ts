import {
  type SessionPR,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { LoopCommand } from "@repo/api/src/types/loop";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { storedSessionPrSchema } from "@/lib/desktop-agent-sessions-schema";

/**
 * The pull requests a workflow action opened, listed on the agent sessions of
 * the run's loops: the Sessions page shows them with a link to the pull
 * request's own page (SessionPR.url), whatever the provider.
 *
 * A runner reports a loop's session from the loop's Claude stream, and the
 * action opens the pull request only after the loop ended, so the session
 * itself never reports it. Each session that worked on the pull request's
 * branch in its repository lists it; plan loops never change the code and are
 * left out. The runner's later syncs carry no pull requests, which keeps the
 * stored list (persist-session-children.ts).
 */

const LOG_PREFIX = "[workflows/run-session-pull-requests]";
const SESSION_PR_TITLE_MAX = 500;

export type RunSessionPullRequest = {
  /** Full name of the repository the pull request is in. */
  repository: string;
  branch: string;
  url: string;
  number: number;
  title?: string;
};

/**
 * Best effort: the pull request is open and recorded on the run, so a failure
 * here is logged and never fails the action that opened it.
 */
export async function attachPullRequestsToRunSessions(input: {
  runId: string;
  organizationId: string;
  pullRequests: readonly RunSessionPullRequest[];
}): Promise<void> {
  if (input.pullRequests.length === 0) {
    return;
  }
  try {
    await withDb.tx((tx) => attachInTransaction(tx, input));
  } catch (error) {
    log.warn(`${LOG_PREFIX} Could not list the pull requests on sessions`, {
      runId: input.runId,
      error: parseError(error),
    });
  }
}

async function attachInTransaction(
  tx: TransactionClient,
  input: {
    runId: string;
    organizationId: string;
    pullRequests: readonly RunSessionPullRequest[];
  }
): Promise<void> {
  const loops = await tx.workflowRunLoop.findMany({
    where: {
      runId: input.runId,
      organizationId: input.organizationId,
      command: { not: LoopCommand.Plan },
    },
    select: { loopId: true },
  });
  const loopIds = loops.map((loop) => loop.loopId);
  if (loopIds.length === 0) {
    return;
  }
  // Locked so two actions of the run reporting at once never drop each
  // other's pull requests from a session.
  await tx.$queryRaw(
    Prisma.sql`SELECT artifact_id FROM session_detail WHERE source_loop_id IN (${Prisma.join(loopIds)}) FOR UPDATE`
  );
  const sessions = await tx.sessionDetail.findMany({
    where: {
      sourceLoopId: { in: loopIds },
      artifact: { organizationId: input.organizationId },
    },
    select: {
      artifactId: true,
      branch: true,
      repositoryFullName: true,
      pullRequests: true,
    },
  });
  for (const session of sessions) {
    const opened = input.pullRequests.filter(
      (pullRequest) =>
        pullRequest.branch === session.branch &&
        isSameRepository(pullRequest.repository, session.repositoryFullName)
    );
    if (opened.length === 0) {
      continue;
    }
    await tx.sessionDetail.update({
      where: { artifactId: session.artifactId },
      data: { pullRequests: withPullRequests(session.pullRequests, opened) },
    });
  }
}

/**
 * The session's stored pull requests with `opened` replacing any entry of the
 * same number. Every entry passes the stored schema, which the read side
 * applies to the list as a whole.
 */
export function withPullRequests(
  stored: unknown,
  opened: readonly RunSessionPullRequest[]
): SessionPR[] {
  const added = opened.flatMap((pullRequest) => {
    const parsed = storedSessionPrSchema.safeParse(toSessionPr(pullRequest));
    return parsed.success ? [parsed.data] : [];
  });
  const numbers = new Set(added.map((pullRequest) => String(pullRequest.num)));
  const kept = readStoredPullRequests(stored).filter(
    (pullRequest) => !numbers.has(String(pullRequest.num))
  );
  return [...kept, ...added];
}

function toSessionPr(pullRequest: RunSessionPullRequest): SessionPR {
  const title = pullRequest.title?.trim().slice(0, SESSION_PR_TITLE_MAX);
  return {
    num: pullRequest.number,
    title: title || `PR #${pullRequest.number}`,
    // What the action saw when it opened the pull request.
    status: SessionPrLifecycleStatus.Open,
    url: pullRequest.url,
  };
}

function readStoredPullRequests(stored: unknown): SessionPR[] {
  const parsed = z.array(storedSessionPrSchema).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

function isSameRepository(
  repository: string,
  sessionRepository: string | null
): boolean {
  return (
    sessionRepository !== null &&
    normalizeRepoFullName(repository) ===
      normalizeRepoFullName(sessionRepository)
  );
}
