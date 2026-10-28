import { createHash } from "node:crypto";
import { INTEGRATION_TOOL_TOKEN_PREFIX } from "@repo/api/src/types/integration-tools";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Status } from "@repo/api/src/types/result";
import { WorkflowActionRunStatus } from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { integrationToolSessionService } from "./integration-tool-session-service";

/**
 * Session tokens: only the computer an instruction attempt was dispatched to
 * (or the STEP loop's own runner) gets one, only its hash is stored, and it
 * stops working once the attempt or loop ends.
 */

const mocks = vi.hoisted(() => ({
  findActionRun: vi.fn(),
  findLoop: vi.fn(),
  updateSessions: vi.fn(),
  findSession: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      workflowActionRun: { findFirst: mocks.findActionRun },
      loop: { findFirst: mocks.findLoop },
      integrationToolSession: {
        updateManyAndReturn: mocks.updateSessions,
        findFirst: mocks.findSession,
        upsert: mocks.upsertSession,
      },
    }),
}));
vi.mock("@/env", () => ({ env: {} }));

const ORG = "0199a5f0-0000-7000-8000-000000000001";
const ACTION_RUN_ID = "0199a5f0-0000-7000-8000-0000000000a1";
const LOOP_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const TARGET = "0199a5f0-0000-7000-8000-0000000000d1";
const EXPIRES_AT = new Date("2026-10-13T09:00:00.000Z");
const TOKEN_RE = /^ist_[A-Za-z0-9_-]{43}$/;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findActionRun.mockResolvedValue({ attempts: 2 });
  mocks.findLoop.mockResolvedValue({ id: LOOP_ID });
  mocks.updateSessions.mockResolvedValue([{ expiresAt: EXPIRES_AT }]);
});

function issue(request: { actionRunId: string } | { loopId: string }) {
  return integrationToolSessionService.issueForComputer({
    organizationId: ORG,
    computeTargetId: TARGET,
    request,
  });
}

describe("integrationToolSessionService.issueForComputer", () => {
  it("gives the dispatched computer a token for the current attempt and stores only its hash", async () => {
    const result = await issue({ actionRunId: ACTION_RUN_ID });

    expect(result).toEqual({
      ok: true,
      value: {
        token: expect.stringMatching(TOKEN_RE),
        expiresAt: EXPIRES_AT.toISOString(),
        mcpUrl: "http://localhost:3010/mcp",
      },
    });
    const token = result.ok ? result.value.token : "";
    expect(mocks.updateSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          actionRunId: ACTION_RUN_ID,
          attempt: 2,
          computeTargetId: TARGET,
        }),
        data: { tokenHash: sha256(token), issuedAt: expect.any(Date) },
      })
    );
    expect(JSON.stringify(mocks.updateSessions.mock.calls)).not.toContain(
      token
    );
  });

  it("gives a running STEP loop's computer its loop's token", async () => {
    const result = await issue({ loopId: LOOP_ID });

    expect(result.ok).toBe(true);
    expect(mocks.findLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: LOOP_ID,
          status: {
            in: [LoopStatus.Pending, LoopStatus.Claimed, LoopStatus.Running],
          },
        }),
      })
    );
    expect(mocks.updateSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          loopId: LOOP_ID,
          computeTargetId: TARGET,
        }),
      })
    );
  });

  it("refuses an action run that is not running", async () => {
    mocks.findActionRun.mockResolvedValue(null);

    expect(await issue({ actionRunId: ACTION_RUN_ID })).toEqual({
      ok: false,
      error: Status.NotFound,
    });
  });

  it("refuses a computer the agent was not dispatched to", async () => {
    mocks.updateSessions.mockResolvedValue([]);

    expect(await issue({ actionRunId: ACTION_RUN_ID })).toEqual({
      ok: false,
      error: Status.NotFound,
    });
  });
});

describe("integrationToolSessionService.issueForLoop", () => {
  it("gives the loop's runner its token without a computer check", async () => {
    const result = await integrationToolSessionService.issueForLoop({
      organizationId: ORG,
      loopId: LOOP_ID,
    });

    expect(result.ok).toBe(true);
    expect(mocks.updateSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          loopId: LOOP_ID,
          organizationId: ORG,
          expiresAt: { gt: expect.any(Date) },
        },
      })
    );
  });

  it("refuses a loop that ended", async () => {
    mocks.findLoop.mockResolvedValue(null);

    expect(
      await integrationToolSessionService.issueForLoop({
        organizationId: ORG,
        loopId: LOOP_ID,
      })
    ).toEqual({ ok: false, error: Status.NotFound });
  });
});

describe("integrationToolSessionService.authenticate", () => {
  const token = `${INTEGRATION_TOOL_TOKEN_PREFIX}abcdefghijklmnopqrstuvwxyz`;

  function instructionRow(actionRun: Record<string, unknown>) {
    return {
      id: "session-1",
      organizationId: ORG,
      runId: "run-1",
      actionRunId: ACTION_RUN_ID,
      attempt: 2,
      loopId: null,
      stepId: null,
      actionRun: {
        status: WorkflowActionRunStatus.Waiting,
        attempts: 2,
        actionId: "action-1",
        event: "execute.completed",
        ...actionRun,
      },
      loop: null,
    };
  }

  function stepRow(status: string) {
    return {
      id: "session-2",
      organizationId: ORG,
      runId: "run-1",
      actionRunId: null,
      attempt: null,
      loopId: LOOP_ID,
      stepId: "investigate",
      actionRun: null,
      loop: { status },
    };
  }

  it("finds an instruction session by the token's hash while its attempt runs", async () => {
    mocks.findSession.mockResolvedValue(instructionRow({}));

    expect(await integrationToolSessionService.authenticate(token)).toEqual({
      id: "session-1",
      organizationId: ORG,
      runId: "run-1",
      subject: {
        kind: "instruction",
        actionRunId: ACTION_RUN_ID,
        attempt: 2,
        actionId: "action-1",
        event: "execute.completed",
      },
    });
    expect(mocks.findSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: sha256(token),
          expiresAt: { gt: expect.any(Date) },
        },
      })
    );
  });

  it("finds a step session while its loop runs", async () => {
    mocks.findSession.mockResolvedValue(stepRow(LoopStatus.Running));

    expect(await integrationToolSessionService.authenticate(token)).toEqual(
      expect.objectContaining({
        subject: { kind: "step", loopId: LOOP_ID, stepId: "investigate" },
      })
    );
  });

  it("revokes a step token once its loop ended", async () => {
    mocks.findSession.mockResolvedValue(stepRow(LoopStatus.Completed));

    expect(await integrationToolSessionService.authenticate(token)).toBeNull();
  });

  it("revokes the token once the action run settled", async () => {
    mocks.findSession.mockResolvedValue(
      instructionRow({ status: WorkflowActionRunStatus.Succeeded })
    );

    expect(await integrationToolSessionService.authenticate(token)).toBeNull();
  });

  it("revokes the token of an earlier attempt", async () => {
    mocks.findSession.mockResolvedValue(instructionRow({ attempts: 3 }));

    expect(await integrationToolSessionService.authenticate(token)).toBeNull();
  });

  it.each([
    null,
    "sk_live_abc",
    "mcp_at_abc",
  ])("ignores %s without looking it up", async (other) => {
    expect(await integrationToolSessionService.authenticate(other)).toBeNull();
    expect(mocks.findSession).not.toHaveBeenCalled();
  });
});

describe("opening sessions", () => {
  it("reopens an instruction attempt's session with no token", async () => {
    await integrationToolSessionService.openForInstruction({
      organizationId: ORG,
      runId: "run-1",
      actionRunId: ACTION_RUN_ID,
      attempt: 2,
      computeTargetId: TARGET,
      expiresAt: EXPIRES_AT,
    });

    expect(mocks.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actionRunId_attempt: { actionRunId: ACTION_RUN_ID, attempt: 2 },
        },
        update: {
          computeTargetId: TARGET,
          expiresAt: EXPIRES_AT,
          tokenHash: null,
          issuedAt: null,
        },
      })
    );
  });

  it("opens a STEP loop's session once", async () => {
    await integrationToolSessionService.openForStep({
      organizationId: ORG,
      runId: "run-1",
      loopId: LOOP_ID,
      stepId: "investigate",
      computeTargetId: TARGET,
      expiresAt: EXPIRES_AT,
    });

    expect(mocks.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { loopId: LOOP_ID },
        create: expect.objectContaining({ stepId: "investigate" }),
      })
    );
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
