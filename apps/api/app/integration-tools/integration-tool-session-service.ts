import { createHash, randomBytes } from "node:crypto";
import {
  INTEGRATION_TOOL_TOKEN_PREFIX,
  type IntegrationSessionGrant,
  type IntegrationSessionRequest,
} from "@repo/api/src/types/integration-tools";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { withDb } from "@repo/database";
import { env } from "@/env";

/**
 * Integration tool sessions (docs/workflows.md "Integration tools"): one per
 * attempt of an instruction's agent, or per STEP loop of a process agent
 * step. The engine opens it when it dispatches the agent to a computer; that
 * computer's runner exchanges the action run (or loop) for a bearer token
 * (only its hash is stored, a new exchange replaces it). A token works while
 * its attempt or loop runs, so finishing, retrying or cancelling it revokes
 * the token.
 */

/** Who a session's tools serve. */
export type ToolSessionSubject =
  | {
      kind: "instruction";
      actionRunId: string;
      attempt: number;
      actionId: string | null;
      event: string;
    }
  | { kind: "step"; loopId: string; stepId: string | null };

/** A session's facts (from a valid token, or for a person's decision). */
export type AuthenticatedToolSession = {
  id: string;
  organizationId: string;
  runId: string;
  subject: ToolSessionSubject;
};

export const integrationToolSessionService = {
  /** Opens an instruction attempt's session before its agent is dispatched. */
  async openForInstruction(input: {
    organizationId: string;
    runId: string;
    actionRunId: string;
    attempt: number;
    computeTargetId: string;
    expiresAt: Date;
  }): Promise<void> {
    await withDb((db) =>
      db.integrationToolSession.upsert({
        where: {
          actionRunId_attempt: {
            actionRunId: input.actionRunId,
            attempt: input.attempt,
          },
        },
        create: input,
        update: {
          computeTargetId: input.computeTargetId,
          expiresAt: input.expiresAt,
          tokenHash: null,
          issuedAt: null,
        },
      })
    );
  },

  /** Opens a STEP loop's session once the loop exists. */
  async openForStep(input: {
    organizationId: string;
    runId: string;
    loopId: string;
    stepId: string;
    computeTargetId: string;
    expiresAt: Date;
  }): Promise<void> {
    await withDb((db) =>
      db.integrationToolSession.upsert({
        where: { loopId: input.loopId },
        create: input,
        update: {
          computeTargetId: input.computeTargetId,
          expiresAt: input.expiresAt,
        },
      })
    );
  },

  /**
   * The token for the runner the attempt or loop was dispatched to (the
   * caller checked that it owns that computer). NotFound when that agent has
   * no open session on this computer.
   */
  async issueForComputer(input: {
    organizationId: string;
    computeTargetId: string;
    request: IntegrationSessionRequest;
  }): Promise<Result<IntegrationSessionGrant, StatusCode>> {
    const subject = await liveSubjectFilter(
      input.organizationId,
      input.request
    );
    if (!subject) {
      return Result.err(Status.NotFound);
    }
    return await issueToken({
      ...subject,
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
    });
  },

  /**
   * The token of a STEP loop's session, for the loop's own runner (the
   * caller proved the loop with its loop-runner JWT). NotFound when the loop
   * has no tools (its step grants none) or no longer runs.
   */
  async issueForLoop(input: {
    organizationId: string;
    loopId: string;
  }): Promise<Result<IntegrationSessionGrant, StatusCode>> {
    const subject = await liveSubjectFilter(input.organizationId, {
      loopId: input.loopId,
    });
    return subject
      ? await issueToken({ ...subject, organizationId: input.organizationId })
      : Result.err(Status.NotFound);
  },

  /** The token's session while its agent runs, else null. */
  async authenticate(
    token: string | null
  ): Promise<AuthenticatedToolSession | null> {
    if (!token?.startsWith(INTEGRATION_TOOL_TOKEN_PREFIX)) {
      return null;
    }
    const session = await withDb((db) =>
      db.integrationToolSession.findFirst({
        where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
        select: SESSION_SELECT,
      })
    );
    return session && isLive(session) ? toSession(session) : null;
  },

  /** A session by id whatever its state, for a person's decision. */
  async find(
    organizationId: string,
    sessionId: string
  ): Promise<AuthenticatedToolSession | null> {
    const session = await withDb((db) =>
      db.integrationToolSession.findFirst({
        where: { id: sessionId, organizationId },
        select: SESSION_SELECT,
      })
    );
    return session ? toSession(session) : null;
  },
};

const DEFAULT_MCP_URL = "http://localhost:3010/mcp";

/** The agent works while its row is running (dispatch) or waiting. */
const LIVE_ACTION_RUN_STATUSES: string[] = [
  WorkflowActionRunStatus.Running,
  WorkflowActionRunStatus.Waiting,
];

/** A STEP loop's agent works until the loop ends. */
const LIVE_LOOP_STATUSES = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

const SESSION_SELECT = {
  id: true,
  organizationId: true,
  runId: true,
  actionRunId: true,
  attempt: true,
  loopId: true,
  stepId: true,
  actionRun: {
    select: { status: true, attempts: true, actionId: true, event: true },
  },
  loop: { select: { status: true } },
} as const;

type SessionRow = {
  id: string;
  organizationId: string;
  runId: string;
  actionRunId: string | null;
  attempt: number | null;
  loopId: string | null;
  stepId: string | null;
  actionRun: {
    status: string;
    attempts: number;
    actionId: string | null;
    event: string;
  } | null;
  loop: { status: string } | null;
};

function isLive(row: SessionRow): boolean {
  if (row.actionRun) {
    return (
      row.actionRun.attempts === row.attempt &&
      LIVE_ACTION_RUN_STATUSES.includes(row.actionRun.status)
    );
  }
  return Boolean(
    row.loop && (LIVE_LOOP_STATUSES as string[]).includes(row.loop.status)
  );
}

function toSession(row: SessionRow): AuthenticatedToolSession | null {
  const base = {
    id: row.id,
    organizationId: row.organizationId,
    runId: row.runId,
  };
  if (row.actionRunId && row.attempt !== null && row.actionRun) {
    return {
      ...base,
      subject: {
        kind: "instruction",
        actionRunId: row.actionRunId,
        attempt: row.attempt,
        actionId: row.actionRun.actionId,
        event: row.actionRun.event,
      },
    };
  }
  return row.loopId
    ? {
        ...base,
        subject: { kind: "step", loopId: row.loopId, stepId: row.stepId },
      }
    : null;
}

/**
 * The session filter of a running agent: the action run's current attempt,
 * or the loop. Null when that agent is not running.
 */
async function liveSubjectFilter(
  organizationId: string,
  request: IntegrationSessionRequest
): Promise<
  { actionRunId: string; attempt: number } | { loopId: string } | null
> {
  if ("actionRunId" in request) {
    const actionRun = await withDb((db) =>
      db.workflowActionRun.findFirst({
        where: {
          id: request.actionRunId,
          organizationId,
          status: { in: LIVE_ACTION_RUN_STATUSES },
        },
        select: { attempts: true },
      })
    );
    return actionRun
      ? { actionRunId: request.actionRunId, attempt: actionRun.attempts }
      : null;
  }
  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        id: request.loopId,
        organizationId,
        status: { in: LIVE_LOOP_STATUSES },
      },
      select: { id: true },
    })
  );
  return loop ? { loopId: request.loopId } : null;
}

/** A new token for the open session the filter names; it replaces any earlier one. */
async function issueToken(
  where: ({ actionRunId: string; attempt: number } | { loopId: string }) & {
    organizationId: string;
    computeTargetId?: string;
  }
): Promise<Result<IntegrationSessionGrant, StatusCode>> {
  const now = new Date();
  const token = `${INTEGRATION_TOOL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [session] = await withDb((db) =>
    db.integrationToolSession.updateManyAndReturn({
      where: { ...where, expiresAt: { gt: now } },
      data: { tokenHash: hashToken(token), issuedAt: now },
      select: { expiresAt: true },
    })
  );
  if (!session) {
    return Result.err(Status.NotFound);
  }
  return Result.ok({
    token,
    expiresAt: session.expiresAt.toISOString(),
    mcpUrl: env.AGENTFLOW_MCP_URL ?? DEFAULT_MCP_URL,
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
