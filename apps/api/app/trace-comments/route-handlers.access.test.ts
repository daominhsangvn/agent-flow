import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-1",
  list: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        { user: mocks.user, clerkUserId: mocks.clerkUserId },
        request,
        context.params
      ),
}));

vi.mock("./service", () => ({
  traceCommentsService: {
    list: mocks.list,
  },
}));

import { createTraceCommentsGetHandler } from "./route-handlers";

function request() {
  return new NextRequest(
    "https://api.example.test/agent-sessions/session-1/trace-comments"
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: "target-1" }) };
}

describe("trace-comment reads (no session-monitoring gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
  });

  it.each([
    TraceCommentTargetType.Session,
    TraceCommentTargetType.Branch,
  ])("serves %s trace comments without a feature flag", async (targetType) => {
    const handler = createTraceCommentsGetHandler(targetType);

    const response = await handler(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
