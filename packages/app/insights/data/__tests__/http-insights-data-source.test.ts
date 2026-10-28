import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpInsightsReads,
  insightsPath,
} from "../http-insights-data-source";

describe("insightsPath", () => {
  it("builds the /insights/{section} path with period and scope", () => {
    const path = insightsPath(
      "delivery",
      InsightsPeriod.Month,
      InsightsScope.Me
    );

    expect(path.startsWith("/insights/delivery?period=30&scope=me")).toBe(true);
  });

  it("only sends period, scope and time zone filters", () => {
    const path = insightsPath("agents", InsightsPeriod.Week, InsightsScope.Org);
    const keys = Array.from(
      new URL(path, "http://localhost").searchParams.keys()
    );

    expect(
      keys.filter((key) => !["period", "scope", "timeZone"].includes(key))
    ).toEqual([]);
  });
});

describe("createHttpInsightsReads", () => {
  it("routes each section getter through api.get with the section path and scope", async () => {
    const get = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const reads = createHttpInsightsReads({ get });

    await reads.getDelivery(InsightsPeriod.Month, InsightsScope.Me);
    await reads.getUtilization(InsightsPeriod.Month, InsightsScope.Org);
    await reads.getAgents(InsightsPeriod.Month, InsightsScope.Org);

    expect(get).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/insights/delivery?period=30&scope=me")
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/insights/utilization?period=30&scope=org")
    );
    expect(get).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/insights/agents?period=30&scope=org")
    );
  });
});
