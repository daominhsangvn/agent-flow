import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRunReplanLoop } from "@/lib/workflows/engine/run-loops";

const ORG = "0199a5f0-0000-7000-8000-00000000000a";
const RUN = "0199a5f0-0000-7000-8000-0000000000c1";
const LOOP = "0199a5f0-0000-7000-8000-0000000000b2";

const mocks = vi.hoisted(() => ({
  link: null as { runId: string } | null,
  earlierPlans: 0,
  countWhere: null as Record<string, unknown> | null,
}));

vi.mock("@repo/database", () => {
  const db = {
    workflowRunLoop: {
      findFirst: vi.fn(() => Promise.resolve(mocks.link)),
      count: vi.fn((args: { where: Record<string, unknown> }) => {
        mocks.countWhere = args.where;
        return Promise.resolve(mocks.earlierPlans);
      }),
    },
  };
  return {
    withDb: (fn: (client: typeof db) => unknown) => fn(db),
  };
});

beforeEach(() => {
  mocks.link = { runId: RUN };
  mocks.earlierPlans = 0;
  mocks.countWhere = null;
});

describe("isRunReplanLoop", () => {
  it("is a re-plan when the run already completed a PLAN loop", async () => {
    mocks.earlierPlans = 1;
    await expect(
      isRunReplanLoop({ id: LOOP, command: LoopCommand.Plan }, ORG)
    ).resolves.toBe(true);
    expect(mocks.countWhere).toMatchObject({
      organizationId: ORG,
      runId: RUN,
      command: LoopCommand.Plan,
      loopId: { not: LOOP },
      loop: { status: LoopStatus.Completed },
    });
  });

  it("is not a re-plan for the run's first PLAN loop", async () => {
    await expect(
      isRunReplanLoop({ id: LOOP, command: LoopCommand.Plan }, ORG)
    ).resolves.toBe(false);
  });

  it("is never a re-plan outside a workflow run (the Plan action on a document)", async () => {
    mocks.link = null;
    mocks.earlierPlans = 3;
    await expect(
      isRunReplanLoop({ id: LOOP, command: LoopCommand.Plan }, ORG)
    ).resolves.toBe(false);
  });

  it("is never a re-plan for other commands", async () => {
    mocks.earlierPlans = 1;
    await expect(
      isRunReplanLoop({ id: LOOP, command: LoopCommand.Execute }, ORG)
    ).resolves.toBe(false);
  });
});
