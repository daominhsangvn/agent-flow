import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { insightsKeys, useDeliveryInsights } from "../use-insights";

describe("useInsights scope", () => {
  it("does not run the query while disabled", () => {
    const source = createSource();

    renderHook(
      () =>
        useDeliveryInsights(InsightsPeriod.Quarter, InsightsScope.Me, false),
      { wrapper: createWrapper(source) }
    );

    expect(source.getDelivery).not.toHaveBeenCalled();
  });

  it("isolates cache entries by scope", async () => {
    const source = createSource();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = createWrapper(source, queryClient);

    const { rerender } = renderHook(
      ({ scope }) => useDeliveryInsights(InsightsPeriod.Quarter, scope),
      {
        initialProps: { scope: InsightsScope.Me as InsightsScope },
        wrapper,
      }
    );

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Me
      )
    );

    rerender({ scope: InsightsScope.Org });

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org
      )
    );

    for (const scope of [InsightsScope.Me, InsightsScope.Org]) {
      expect(
        queryClient.getQueryData(
          insightsKeys.section("delivery", InsightsPeriod.Quarter, scope)
        )
      ).toEqual({ charts: {}, kpis: [] });
    }
  });
});

function createSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me, InsightsScope.Org],
    availableSections: [InsightsSection.Delivery],
    getDelivery: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getUtilization: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getAgents: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
  };
}

function createWrapper(
  source: InsightsDataSource,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <InsightsDataSourceProvider value={source}>
        {children}
      </InsightsDataSourceProvider>
    </QueryClientProvider>
  );
}
