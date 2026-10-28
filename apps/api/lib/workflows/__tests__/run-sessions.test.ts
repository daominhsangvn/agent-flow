import { LoopCommand } from "@repo/api/src/types/loop";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRunSessions } from "@/lib/workflows/run-sessions";

const IDS = {
  org: "0199a5f0-0000-7000-8000-00000000000a",
  planLoop: "0199a5f0-0000-7000-8000-0000000000c1",
  stepLoop: "0199a5f0-0000-7000-8000-0000000000c2",
  activeSession: "0199a5f0-0000-7000-8000-0000000000d1",
  endedSession: "0199a5f0-0000-7000-8000-0000000000d2",
};

const mocks = vi.hoisted(() => ({
  db: { sessionDetail: { findMany: vi.fn() } },
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(mocks.db),
}));

const LOOPS = [
  { loopId: IDS.planLoop, command: LoopCommand.Plan, stepId: null },
  { loopId: IDS.stepLoop, command: LoopCommand.Step, stepId: "review" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listRunSessions", () => {
  it("returns the sessions of the run's loops with their loop and displayed status", async () => {
    const now = new Date();
    mocks.db.sessionDetail.findMany.mockResolvedValue([
      sessionRow({
        artifactId: IDS.activeSession,
        sourceLoopId: IDS.stepLoop,
        status: "active",
        startedAt: now,
        lastActivityAt: now,
      }),
      sessionRow({
        artifactId: IDS.endedSession,
        sourceLoopId: IDS.planLoop,
        status: "inactive",
        startedAt: new Date("2026-10-01T10:00:00.000Z"),
        endedAt: new Date("2026-10-01T10:20:00.000Z"),
      }),
    ]);

    const sessions = await listRunSessions(IDS.org, LOOPS);

    expect(sessions).toEqual([
      expect.objectContaining({
        id: IDS.activeSession,
        slug: "SES-1",
        loopId: IDS.stepLoop,
        command: LoopCommand.Step,
        stepId: "review",
        status: DISPLAYED_SESSION_STATUS.ACTIVE,
      }),
      expect.objectContaining({
        id: IDS.endedSession,
        loopId: IDS.planLoop,
        command: LoopCommand.Plan,
        stepId: null,
        status: DISPLAYED_SESSION_STATUS.INACTIVE,
      }),
    ]);
    expect(mocks.db.sessionDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceLoopId: { in: [IDS.planLoop, IDS.stepLoop] },
          artifact: { is: { organizationId: IDS.org } },
        },
      })
    );
  });

  it("shows an active session awaiting input as waiting", async () => {
    const now = new Date();
    mocks.db.sessionDetail.findMany.mockResolvedValue([
      sessionRow({
        artifactId: IDS.activeSession,
        sourceLoopId: IDS.planLoop,
        status: "active",
        startedAt: now,
        lastActivityAt: now,
        awaitingInputSince: now,
      }),
    ]);

    const [session] = await listRunSessions(IDS.org, LOOPS);

    expect(session?.status).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("does not query without loops", async () => {
    expect(await listRunSessions(IDS.org, [])).toEqual([]);
    expect(mocks.db.sessionDetail.findMany).not.toHaveBeenCalled();
  });
});

function sessionRow(input: {
  artifactId: string;
  sourceLoopId: string;
  status: string;
  startedAt: Date;
  lastActivityAt?: Date;
  endedAt?: Date;
  awaitingInputSince?: Date;
}) {
  return {
    artifactId: input.artifactId,
    sourceLoopId: input.sourceLoopId,
    harness: "claude-code",
    model: "claude-opus-5-5",
    sessionStartedAt: input.startedAt,
    lastActivityAt: input.lastActivityAt ?? null,
    sessionEndedAt: input.endedAt ?? null,
    awaitingInputSince: input.awaitingInputSince ?? null,
    artifact: { slug: "SES-1", name: "Plan PROJ-7", status: input.status },
  };
}
