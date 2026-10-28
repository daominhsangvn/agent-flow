import {
  INSIGHTS_SCOPE_OPTIONS,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsPageHeader,
  DEFAULT_SESSION_ANALYTICS_PERIOD,
  DEFAULT_SESSION_ANALYTICS_SCOPE,
  SESSION_ANALYTICS_SCOPES,
} from "../analytics-page-header";

/**
 * The one piece of chrome both session-analytics screens wear. Raised in review
 * (comment 3711234870): it had no coverage, and the part most likely to drift is
 * that its scope list is DERIVED — `INSIGHTS_SCOPE_OPTIONS` minus `Team` — so a
 * scope added upstream silently changes what these two screens offer.
 *
 * These assertions are written against the canonical list rather than against a
 * hardcoded pair, so adding a scope upstream fails HERE with a clear reason
 * instead of quietly appearing in two screens' dropdowns.
 */

function renderHeader(overrides: Record<string, unknown> = {}) {
  const onScopeChange = vi.fn();
  const onPeriodChange = vi.fn();
  render(
    <AnalyticsPageHeader
      onPeriodChange={onPeriodChange}
      onScopeChange={onScopeChange}
      period={DEFAULT_SESSION_ANALYTICS_PERIOD}
      scope={DEFAULT_SESSION_ANALYTICS_SCOPE}
      subtitle="Time spent on sessions that produced nothing"
      title="Lost work"
      {...overrides}
    />
  );
  return { onPeriodChange, onScopeChange };
}

describe("the shared analytics page header", () => {
  it("renders the title and subtitle it is given", () => {
    renderHeader();

    expect(
      screen.getByRole("heading", { name: "Lost work" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Time spent on sessions that produced nothing")
    ).toBeInTheDocument();
  });

  it("offers every Insights scope, Me before Organization", () => {
    expect(SESSION_ANALYTICS_SCOPES).toEqual([
      InsightsScope.Me,
      InsightsScope.Org,
    ]);
    expect(SESSION_ANALYTICS_SCOPES).toEqual(INSIGHTS_SCOPE_OPTIONS);
  });

  it("defaults to the organization view over the 30-day window", () => {
    expect(DEFAULT_SESSION_ANALYTICS_SCOPE).toBe(InsightsScope.Org);
    expect(DEFAULT_SESSION_ANALYTICS_PERIOD).toBe(InsightsPeriod.Month);
  });

  it("gives both controls an accessible name", () => {
    renderHeader();

    // Icon-free but value-only triggers: without these the screen reader hears
    // two unlabelled comboboxes reading "Organization" and "30 days".
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Time period" })
    ).toBeInTheDocument();
  });
});
