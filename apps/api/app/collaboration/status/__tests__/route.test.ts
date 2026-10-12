import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";

const mockAuthContext: AuthContext = createTestAuthContext();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

const { GET } = await import("../route");

describe("GET /collaboration/status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("reports collaboration when LIVEBLOCKS_SECRET is set", async () => {
    vi.stubEnv("LIVEBLOCKS_SECRET", "sk_test_configured");

    const response = await requestStatus();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { enabled: true },
    });
  });

  test("reports no collaboration on a server without Liveblocks", async () => {
    vi.stubEnv("LIVEBLOCKS_SECRET", "");

    const response = await requestStatus();

    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { enabled: false },
    });
  });
});

function requestStatus() {
  return GET(
    createMockRequest({ url: "http://localhost:3002/collaboration/status" }),
    createMockRouteContext({})
  );
}
