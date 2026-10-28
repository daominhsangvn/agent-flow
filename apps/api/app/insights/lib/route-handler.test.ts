import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { ApproverRole } from "@repo/api/src/types/user";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  isInsightsEnabledForUser: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/insights-feature", () => ({
  isInsightsEnabledForUser: mocks.isInsightsEnabledForUser,
}));

import { createInsightsHandler } from "./route-handler";

const USER = {
  active: true,
  avatarUrl: null,
  clerkId: "clerk_user_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  email: "test@example.com",
  firstName: "Test",
  githubUsername: null,
  id: "019f0fcb-8336-7c4d-9f64-528fb9520c31",
  lastName: "User",
  linearId: null,
  organizationId: "019f0fcb-8336-7c4d-9f64-528fb9520c30",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  slackId: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

// `team` was removed from InsightsScope; the enum now rejects it.
const REMOVED_TEAM_SCOPE = "team";
const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";

const AUTH = {
  user: USER,
  clerkOrgId: "org_clerk_1",
  clerkUserId: "user_clerk_1",
};

function buildHandler(
  section: InsightsSection,
  fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} })
) {
  return {
    fetch,
    handler: createInsightsHandler({
      fetch,
      section,
      errorMessage: "Failed to load insights",
    }),
  };
}

describe("createInsightsHandler removed team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
  });

  it("rejects scope=team before any service call", async () => {
    const { handler, fetch } = buildHandler(InsightsSection.Delivery);

    const response = await handler(
      AUTH,
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${REMOVED_TEAM_SCOPE}`
      )
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects the removed teamId param as an unsupported filter", async () => {
    const { handler, fetch } = buildHandler(InsightsSection.Delivery);

    const response = await handler(
      AUTH,
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createInsightsHandler insights feature flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
  });

  it("evaluates the flag against the request principal for the default scope", async () => {
    const { handler } = buildHandler(InsightsSection.Delivery);

    const response = await handler(
      AUTH,
      request(`/insights/delivery?period=${InsightsPeriod.Quarter}`)
    );

    expect(response.status).toBe(200);
    expect(mocks.isInsightsEnabledForUser).toHaveBeenCalledWith({
      userId: USER.id,
      clerkUserId: "user_clerk_1",
    });
  });

  it("denies the disabled flag before params or service access", async () => {
    mocks.isInsightsEnabledForUser.mockResolvedValueOnce(false);
    const { handler, fetch } = buildHandler(InsightsSection.Delivery);

    const response = await handler(
      AUTH,
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Org}`
      )
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Note: the "fails closed when flag evaluation is unavailable" path is
  // covered in insights-feature.test.ts, where the PostHog client is mocked to
  // throw/return null. At this route-handler level `isInsightsEnabledForUser`
  // is mocked, so an "unavailable" case is indistinguishable from "disabled"
  // (both resolve `false`) — a duplicate of the test above, removed here.
});

describe("createInsightsHandler failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
  });

  it("logs a section failure with the org/user/scope correlation", async () => {
    const error = new Error("insights service unavailable");
    const { handler } = buildHandler(
      InsightsSection.Delivery,
      vi.fn().mockRejectedValue(error)
    );

    const response = await handler(
      AUTH,
      request(
        `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Org}`
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith("insights.delivery_failed", {
      error,
      organizationId: USER.organizationId,
      userId: USER.id,
      scope: InsightsScope.Org,
    });
  });
});

describe("createInsightsHandler unsupported query params (ISS-4505)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInsightsEnabledForUser.mockResolvedValue(true);
  });

  it("rejects unsupported query params on the default path", async () => {
    const { handler, fetch } = buildHandler(InsightsSection.Delivery);

    const response = await handler(
      AUTH,
      request("/insights/delivery?unknownFilter=value")
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`);
}
