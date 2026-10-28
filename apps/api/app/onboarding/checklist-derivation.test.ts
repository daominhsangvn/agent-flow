/**
 * The onboarding checklist's completion is derived from live data, so these
 * cover what the runner row actually keys off.
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

const { withDb } = await import("@repo/database");
const { onboardingService, INSTALL_RUNNER_HREF } = await import("./service");

const ORG_ID = "org-1";

type DbOverrides = {
  projectCount?: number;
  computeTarget?: { id: string } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
};

const computeTargetFindFirst = vi.fn();

function stubDb(overrides: DbOverrides = {}) {
  computeTargetFindFirst.mockResolvedValue(overrides.computeTarget ?? null);

  const db = {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        settings: { onboarding: { wizardCompletedAt: "2026-08-01T00:00:00Z" } },
      }),
    },
    project: { count: vi.fn().mockResolvedValue(overrides.projectCount ?? 1) },
    computeTarget: { findFirst: computeTargetFindFirst },
    googleIntegration: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.googleIntegration ?? null),
    },
    user: { count: vi.fn().mockResolvedValue(overrides.userCount ?? 1) },
  };

  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
}

async function getRunnerItem() {
  const status = await onboardingService.getStatus(ORG_ID);
  return status.checklist.find(
    (item) => item.id === ChecklistItemId.InstallRunner
  );
}

describe("onboarding checklist — runner row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("points at the settings page that lists the runners", async () => {
    stubDb();

    const item = await getRunnerItem();

    expect(item?.label).toBe("Download and install a runner");
    expect(item?.href).toBe(INSTALL_RUNNER_HREF);
    expect(INSTALL_RUNNER_HREF).toBe("/settings?tab=integrations");
  });

  it("stays incomplete until a runner registers", async () => {
    stubDb({ computeTarget: null });

    expect((await getRunnerItem())?.completed).toBe(false);
  });

  it("completes once the organization has a runner", async () => {
    stubDb({ computeTarget: { id: "ct-1" } });

    expect((await getRunnerItem())?.completed).toBe(true);
  });

  it("asks whether the organization has any runner, whoever added it", async () => {
    stubDb();

    await getRunnerItem();

    // Org scope: loops run on the project's or the organization's runners,
    // so one runner serves every member. `isCloudSentinel: false` because the
    // per-org cloud sentinel has no device behind it.
    expect(computeTargetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, isCloudSentinel: false },
      })
    );
  });

  it("sends every row to an in-app destination", async () => {
    stubDb();

    const status = await onboardingService.getStatus(ORG_ID);

    for (const item of status.checklist) {
      if (item.href === undefined) {
        continue;
      }
      // The checklist routes every href through the in-app navigation Link.
      expect(item.href.startsWith("/"), `${item.id} leaves the app`).toBe(true);
    }
  });
});
