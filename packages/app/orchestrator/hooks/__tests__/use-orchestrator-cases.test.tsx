import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCaseActive,
  useOrchestratorCase,
  useWorkflowOrchestratorCases,
} from "../use-orchestrator-cases";

const CASE_ID = "case-1";

const mockApiClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("isCaseActive", () => {
  it("is false without data", () => {
    expect(isCaseActive(undefined)).toBe(false);
  });

  it("is true while a turn runs", () => {
    expect(isCaseActive({ turnRunning: true, activeTaskCount: 0 })).toBe(true);
  });

  it("is true while tasks are active", () => {
    expect(isCaseActive({ turnRunning: false, activeTaskCount: 2 })).toBe(true);
  });

  it("is false when idle", () => {
    expect(isCaseActive({ turnRunning: false, activeTaskCount: 0 })).toBe(
      false
    );
  });
});

describe("useOrchestratorCase", () => {
  beforeEach(() => {
    mockApiClient.get.mockReset();
    mockApiClient.get.mockResolvedValue({
      id: CASE_ID,
      turnRunning: false,
      activeTaskCount: 0,
    });
  });

  it("reads the case from its path", async () => {
    const { result } = renderHook(() => useOrchestratorCase(CASE_ID), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/orchestrator/cases/${CASE_ID}`
    );
  });
});

describe("useWorkflowOrchestratorCases", () => {
  it("reads the workflow's cases from its path", async () => {
    mockApiClient.get.mockReset();
    mockApiClient.get.mockResolvedValue([]);
    const { result } = renderHook(() => useWorkflowOrchestratorCases("w 1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith("/workflows/w%201/cases");
  });
});
