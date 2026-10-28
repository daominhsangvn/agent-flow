import { OrchestratorCaseStatus } from "@repo/api/src/types/orchestrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCaseCounts } from "@/lib/workflows/workflow-case-counts";

const mocks = vi.hoisted(() => ({ groupBy: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ orchestratorCase: { groupBy: mocks.groupBy } }),
}));

const ORG = "org-1";
const WF = "wf-1";

describe("loadCaseCounts", () => {
  beforeEach(() => {
    mocks.groupBy.mockReset();
  });

  it("makes no query without workflow ids", async () => {
    const counts = await loadCaseCounts(ORG, []);

    expect(counts.size).toBe(0);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("gives an orchestrated workflow without cases zeros", async () => {
    mocks.groupBy.mockResolvedValue([]);

    const counts = await loadCaseCounts(ORG, [WF]);

    expect(counts.get(WF)).toEqual({
      total: 0,
      open: 0,
      closed: 0,
      lastActivityAt: null,
    });
  });

  it("sums status groups and keeps the latest activity", async () => {
    const early = new Date("2026-10-01T00:00:00.000Z");
    const late = new Date("2026-10-05T00:00:00.000Z");
    mocks.groupBy.mockResolvedValue([
      {
        workflowId: WF,
        status: OrchestratorCaseStatus.Open,
        _count: { _all: 2 },
        _max: { updatedAt: early },
      },
      {
        workflowId: WF,
        status: OrchestratorCaseStatus.Closed,
        _count: { _all: 3 },
        _max: { updatedAt: late },
      },
    ]);

    const counts = await loadCaseCounts(ORG, [WF]);

    expect(counts.get(WF)).toEqual({
      total: 5,
      open: 2,
      closed: 3,
      lastActivityAt: late,
    });
  });

  it("scopes the query to the organization", async () => {
    mocks.groupBy.mockResolvedValue([]);

    await loadCaseCounts(ORG, [WF]);

    expect(mocks.groupBy.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      workflowId: { in: [WF] },
    });
  });
});
