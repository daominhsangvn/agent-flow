import { ReviewDecisionKind } from "@repo/api/src/types/project-process";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /workflow-runs/{id}/review: any member asks for changes; approving
 * (or completing) and rejecting are for org admins, like approvals.
 */

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
  decideReview: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));
vi.mock("@/lib/workflows/run-step-input-service", () => ({
  workflowRunStepInputService: { decideReview: mocks.decideReview },
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

import { POST as decideReview } from "@/app/workflow-runs/[runId]/review/route";

const RUN_ID = "0199a5f0-0000-7000-8000-0000000000b1";

function post(body: unknown) {
  return decideReview(
    new NextRequest(`http://localhost/workflow-runs/${RUN_ID}/review`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ runId: RUN_ID }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgAdminStatus.mockResolvedValue({
    isAdmin: false,
    reason: "not_admin",
  });
  mocks.decideReview.mockResolvedValue(Result.ok({ id: RUN_ID }));
});

describe("POST /workflow-runs/{id}/review", () => {
  it("lets any member ask for changes", async () => {
    const response = await post({
      decision: ReviewDecisionKind.Feedback,
      comment: "Split the task",
    });

    expect(response.status).toBe(200);
    expect(mocks.decideReview).toHaveBeenCalledWith("org-1", "user-1", RUN_ID, {
      decision: ReviewDecisionKind.Feedback,
      comment: "Split the task",
    });
  });

  it.each([
    ReviewDecisionKind.Approve,
    ReviewDecisionKind.Reject,
  ])("keeps %s for org admins", async (decision) => {
    const denied = await post({ decision });
    expect(denied.status).toBe(403);
    expect(mocks.decideReview).not.toHaveBeenCalled();

    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    const allowed = await post({ decision });
    expect(allowed.status).toBe(200);
  });

  it("refuses an unknown decision and maps a run that does not wait to 409", async () => {
    expect((await post({ decision: "maybe" })).status).toBe(400);

    mocks.decideReview.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: "The run is not waiting for a review.",
      })
    );
    expect((await post({ decision: ReviewDecisionKind.Feedback })).status).toBe(
      409
    );
  });
});
