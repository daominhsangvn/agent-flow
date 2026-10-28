import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentRunnerStatus, useAgentOnboarding } from "../use-agent-onboarding";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockMembership = { role: "org:admin" };
const mockOrganization = { id: "org-test-123" };
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({
    membership: mockMembership,
    organization: mockOrganization,
  }),
}));

vi.mock("@repo/app/shared/lib/role-utils", () => ({
  isAdminRole: (role: string | undefined) =>
    role === "org:admin" || role === "org:owner",
}));

describe("useAgentOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockMembership.role = "org:admin";
    mockApiClient.get.mockImplementation((path: string) => {
      // useAgentOnboarding fetches component inventory via useAgentComponents,
      // which calls GET /agent-components and returns AgentComponentListResponse
      // ({ items, total, hasMore }). needsBootstrap keys off `total === 0`.
      if (path.startsWith("/agent-components")) {
        return Promise.resolve({ items: [], total: 0, hasMore: false });
      }
      if (path === "/compute-targets") {
        return Promise.resolve([{ id: "ct-1", isOnline: true }]);
      }
      return Promise.resolve({});
    });
  });

  test("shouldShow is true when org has 0 agents, is admin, not dismissed", async () => {
    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    // Wait for queries to resolve
    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.shouldShow).toBe(true);
    expect(result.current.needsBootstrap).toBe(true);
    expect(result.current.runner).toBe(AgentRunnerStatus.Online);
    expect(result.current.prereqsMet).toBe(true);
    expect(result.current.isAdmin).toBe(true);
  });

  test("shouldShow is false when org has agents", async () => {
    mockApiClient.get.mockImplementation((path: string) => {
      if (path.startsWith("/agent-components")) {
        return Promise.resolve({
          items: [{ id: "a1", name: "Test Agent" }],
          total: 1,
          hasMore: false,
        });
      }
      if (path === "/compute-targets") {
        return Promise.resolve([{ id: "ct-1", isOnline: true }]);
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.shouldShow).toBe(false);
    expect(result.current.needsBootstrap).toBe(false);
  });

  test("shouldShow is false when dismissed", () => {
    localStorage.setItem(
      "agents:onboarding:dismissed:org-test-123",
      JSON.stringify(true)
    );

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isDismissed).toBe(true);
    expect(result.current.shouldShow).toBe(false);
  });

  test("dismiss persists to localStorage", () => {
    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
    expect(
      localStorage.getItem("agents:onboarding:dismissed:org-test-123")
    ).toBe(JSON.stringify(true));
  });

  test("shouldShow is false for non-admin users", () => {
    mockMembership.role = "org:member";

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isAdmin).toBe(false);
    expect(result.current.shouldShow).toBe(false);
  });

  test("queries are not fired when dismissed", () => {
    localStorage.setItem(
      "agents:onboarding:dismissed:org-test-123",
      JSON.stringify(true)
    );

    renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("does not ask for GitHub: an online runner is the whole prerequisite", async () => {
    mockApiClient.get.mockImplementation((path: string) => {
      if (path.startsWith("/agent-components")) {
        return Promise.resolve({ items: [], total: 0, hasMore: false });
      }
      if (path === "/integrations/github") {
        return Promise.resolve({ connected: false });
      }
      if (path === "/compute-targets") {
        return Promise.resolve([{ id: "ct-1", isOnline: true }]);
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.prereqsMet).toBe(true);
    const requested = mockApiClient.get.mock.calls.map(([path]) => path);
    expect(requested).not.toContain("/integrations/github");
  });

  test("a runner that is installed but offline does not meet the prerequisite", async () => {
    mockComputeTargets([{ id: "ct-1", isOnline: false }]);

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.runner).toBe(AgentRunnerStatus.Offline);
    expect(result.current.prereqsMet).toBe(false);
  });

  test("without any runner the prerequisite is to install one", async () => {
    mockComputeTargets([]);

    const { result } = renderHook(() => useAgentOnboarding(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.runner).toBe(AgentRunnerStatus.None);
    expect(result.current.prereqsMet).toBe(false);
  });
});

/** An org with no agents yet, whose user can start loops on `targets`. */
function mockComputeTargets(targets: { id: string; isOnline: boolean }[]) {
  mockApiClient.get.mockImplementation((path: string) => {
    if (path.startsWith("/agent-components")) {
      return Promise.resolve({ items: [], total: 0, hasMore: false });
    }
    if (path === "/compute-targets") {
      return Promise.resolve(targets);
    }
    return Promise.resolve({});
  });
}
