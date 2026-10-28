/**
 * Unit tests for onboardingService.getStatus.
 *
 * Verifies the checklist returns the five expected items, in order, and that
 * each one's completion follows the data it keys off.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import { onboardingService } from "@/app/onboarding/service";

const mockWithDb = withDb as unknown as Mock;

const ORG_ID = "org-1";

/**
 * Set up the five sequential withDb calls that getStatus makes:
 *   1. organization.findUnique (org settings)
 *   2. project.count
 *   3. computeTarget.findFirst (any runner of the organization)
 *   4. googleIntegration.findUnique
 *   5. user.count
 *
 * The mocks are positional, so a call added to the service's `Promise.all` has
 * to be added here at the same index or every later stub answers the wrong
 * query.
 */
function mockGetStatusCalls({
  org = { settings: {} },
  projectCount = 0,
  computeTarget = null,
  googleIntegration = null,
  userCount = 1,
}: {
  org?: { settings: object };
  projectCount?: number;
  computeTarget?: { id: string } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
} = {}) {
  mockWithDb
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        organization: {
          findUnique: vi.fn().mockResolvedValue(org),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ project: { count: vi.fn().mockResolvedValue(projectCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        computeTarget: {
          findFirst: vi.fn().mockResolvedValue(computeTarget),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(googleIntegration),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ user: { count: vi.fn().mockResolvedValue(userCount) } })
    );
}

describe("onboardingService.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include a ConnectLinear item in the checklist", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID);

    const ids = status.checklist.map((item) => item.id);
    expect(ids).not.toContain("CONNECT_LINEAR");
  });

  it("returns exactly the four expected checklist items in order", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID);

    expect(status.checklist.map((item) => item.id)).toEqual([
      ChecklistItemId.CreateProject,
      ChecklistItemId.InstallRunner,
      ChecklistItemId.ConnectGoogle,
      ChecklistItemId.InviteMembers,
    ]);
  });

  it("no longer asks to connect GitHub or add an Anthropic API key", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID);

    const labels = status.checklist.map((item) => item.label);
    expect(labels).not.toContain("Connect GitHub");
    expect(labels).not.toContain("Add Anthropic API key");
    expect(labels).not.toContain("Download the desktop app");
  });

  it("treats a legacy org with a project and no wizard record as completed", async () => {
    mockGetStatusCalls({ projectCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID);

    expect(status.wizardCompleted).toBe(true);
  });

  it("does not treat an org without a project or wizard record as completed", async () => {
    mockGetStatusCalls({ projectCount: 0 });

    const status = await onboardingService.getStatus(ORG_ID);

    expect(status.wizardCompleted).toBe(false);
  });

  it("marks InstallRunner complete when the organization has a runner", async () => {
    mockGetStatusCalls({ computeTarget: { id: "runner-1" } });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InstallRunner
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InstallRunner incomplete when the organization has no runner", async () => {
    mockGetStatusCalls({ computeTarget: null });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InstallRunner
    );
    expect(item?.completed).toBe(false);
  });

  it("marks ConnectGoogle complete when a Google integration exists", async () => {
    mockGetStatusCalls({ googleIntegration: { id: "google-1" } });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGoogle
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers complete when userCount is greater than one", async () => {
    mockGetStatusCalls({ userCount: 2 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers incomplete when userCount is one", async () => {
    mockGetStatusCalls({ userCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(false);
  });
});
