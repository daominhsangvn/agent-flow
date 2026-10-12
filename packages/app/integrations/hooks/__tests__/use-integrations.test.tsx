import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  jiraConnection,
  PROVIDERS,
} from "../../__tests__/integration-fixtures";
import { IntegrationMutationErrorTitle } from "../../lib/mutation-error";
import { integrationKeys } from "../integration-keys";
import {
  useCreateIntegrationConnection,
  useDeleteIntegrationConnection,
  useIntegrationConnection,
  useIntegrationConnections,
  useIntegrationDeliveries,
  useIntegrationInbound,
  useIntegrationProviders,
  useRotateIntegrationInbound,
  useTestIntegrationConnection,
  useUpdateIntegrationConnection,
} from "../use-integrations";

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

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

const CONNECTION_PATH = `/integrations/connections/${JIRA_CONNECTION_ID}`;

function setup() {
  const queryClient = createTestQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const setData = vi.spyOn(queryClient, "setQueryData");
  const remove = vi.spyOn(queryClient, "removeQueries");
  return {
    queryClient,
    invalidate,
    setData,
    remove,
    wrapper: createWrapperWithClient(queryClient),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("integrationKeys", () => {
  it("nests inbound details and deliveries under the connection detail", () => {
    expect(integrationKeys.inbound("c1").slice(0, 4)).toEqual(
      integrationKeys.connectionDetail("c1")
    );
    expect(integrationKeys.deliveries("c1").slice(0, 4)).toEqual(
      integrationKeys.connectionDetail("c1")
    );
    expect(integrationKeys.connectionList().slice(0, 2)).toEqual(
      integrationKeys.connections()
    );
  });
});

describe("queries", () => {
  it("reads the provider catalog and unwraps the providers", async () => {
    mockApiClient.get.mockResolvedValue({ providers: PROVIDERS });
    const { wrapper } = setup();
    const { result } = renderHook(() => useIntegrationProviders(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith("/integrations/providers");
    expect(result.current.data).toEqual(PROVIDERS);
  });

  it("lists connections and reads one connection", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/integrations/connections"
          ? { connections: [jiraConnection] }
          : jiraConnection
      )
    );
    const { wrapper } = setup();
    const list = renderHook(() => useIntegrationConnections(), { wrapper });
    const detail = renderHook(
      () => useIntegrationConnection(JIRA_CONNECTION_ID),
      { wrapper }
    );

    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(list.result.current.data).toEqual([jiraConnection]);
    expect(mockApiClient.get).toHaveBeenCalledWith(CONNECTION_PATH);
  });

  it("does not fetch inbound details or deliveries until enabled", async () => {
    mockApiClient.get.mockResolvedValue({ deliveries: [] });
    const { wrapper } = setup();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useIntegrationInbound(JIRA_CONNECTION_ID, { enabled });
        return useIntegrationDeliveries(JIRA_CONNECTION_ID, { enabled });
      },
      { initialProps: { enabled: false }, wrapper }
    );

    expect(mockApiClient.get).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `${CONNECTION_PATH}/inbound`
      )
    );
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `${CONNECTION_PATH}/deliveries`
    );
  });
});

describe("mutations", () => {
  it("creates a connection with POST and refreshes the connections", async () => {
    mockApiClient.post.mockResolvedValue(jiraConnection);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreateIntegrationConnection(), {
      wrapper,
    });
    const input = {
      provider: jiraConnection.provider,
      name: "Acme Jira",
      config: { siteUrl: "https://acme.atlassian.net" },
      secrets: { apiToken: "secret" },
      deliveryMode: IntegrationDeliveryMode.Webhook,
      pollIntervalSeconds: 120,
    };

    await act(() => result.current.mutateAsync(input));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/connections",
      input
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: integrationKeys.connections(),
    });
  });

  it("updates a connection with PATCH", async () => {
    mockApiClient.patch.mockResolvedValue(jiraConnection);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpdateIntegrationConnection(), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({
        id: JIRA_CONNECTION_ID,
        input: { name: "Renamed" },
      })
    );

    expect(mockApiClient.patch).toHaveBeenCalledWith(CONNECTION_PATH, {
      name: "Renamed",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: integrationKeys.connections(),
    });
  });

  it("deletes a connection, drops its detail cache and refreshes the list", async () => {
    mockApiClient.delete.mockResolvedValue({ deleted: true });
    const { wrapper, invalidate, remove } = setup();
    const { result } = renderHook(() => useDeleteIntegrationConnection(), {
      wrapper,
    });

    await act(() => result.current.mutateAsync(JIRA_CONNECTION_ID));

    expect(mockApiClient.delete).toHaveBeenCalledWith(CONNECTION_PATH);
    expect(remove).toHaveBeenCalledWith({
      queryKey: integrationKeys.connectionDetail(JIRA_CONNECTION_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: integrationKeys.connectionList(),
    });
  });

  it("tests a connection with POST .../test and returns the result", async () => {
    const testResult = { ok: false, account: null, error: "401 Unauthorized" };
    mockApiClient.post.mockResolvedValue(testResult);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useTestIntegrationConnection(), {
      wrapper,
    });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync(JIRA_CONNECTION_ID);
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${CONNECTION_PATH}/test`,
      {}
    );
    expect(returned).toEqual(testResult);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: integrationKeys.connections(),
    });
  });

  it("rotates the inbound endpoint and caches the new details", async () => {
    const details = {
      inboundUrl: "https://api.acme.dev/webhooks/integrations/new-key",
      inboundSecret: "new-secret",
      setupInstructions: "Do this",
    };
    mockApiClient.post.mockResolvedValue(details);
    const { wrapper, invalidate, setData } = setup();
    const { result } = renderHook(() => useRotateIntegrationInbound(), {
      wrapper,
    });

    await act(() => result.current.mutateAsync(JIRA_CONNECTION_ID));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${CONNECTION_PATH}/inbound/rotate`,
      {}
    );
    expect(setData).toHaveBeenCalledWith(
      integrationKeys.inbound(JIRA_CONNECTION_ID),
      details
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: integrationKeys.connectionList(),
    });
  });
});

describe("mutation errors", () => {
  const INVALID_SITE_URL_MESSAGE =
    "Invalid configuration: siteUrl: The Jira site URL must start with https://";

  /** The app's real QueryClient, whose default mutation toast only knows error codes. */
  function setupWithAppClient() {
    return { wrapper: createWrapperWithClient(makeQueryClient()) };
  }

  it("toasts the server's message instead of the generic failure", async () => {
    mockApiClient.post.mockRejectedValue(
      new ApiError(INVALID_SITE_URL_MESSAGE, 400)
    );
    const { wrapper } = setupWithAppClient();
    const { result } = renderHook(() => useCreateIntegrationConnection(), {
      wrapper,
    });

    await act(async () => {
      await result.current
        .mutateAsync({
          provider: jiraConnection.provider,
          name: "Acme Jira",
          config: { siteUrl: "http://acme.atlassian.net" },
          secrets: { apiToken: "secret" },
          deliveryMode: IntegrationDeliveryMode.Webhook,
          pollIntervalSeconds: 120,
        })
        .catch(() => undefined);
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(
      IntegrationMutationErrorTitle.CreateConnection,
      { description: INVALID_SITE_URL_MESSAGE }
    );
    await waitFor(() =>
      expect(result.current.error?.message).toBe(INVALID_SITE_URL_MESSAGE)
    );
  });

  type Wrapper = ReturnType<typeof createWrapperWithClient>;

  it.each([
    {
      title: IntegrationMutationErrorTitle.UpdateConnection,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useUpdateIntegrationConnection(), {
          wrapper,
        });
        return () =>
          result.current.mutateAsync({ id: JIRA_CONNECTION_ID, input: {} });
      },
    },
    {
      title: IntegrationMutationErrorTitle.DeleteConnection,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useDeleteIntegrationConnection(), {
          wrapper,
        });
        return () => result.current.mutateAsync(JIRA_CONNECTION_ID);
      },
    },
    {
      title: IntegrationMutationErrorTitle.TestConnection,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useTestIntegrationConnection(), {
          wrapper,
        });
        return () => result.current.mutateAsync(JIRA_CONNECTION_ID);
      },
    },
    {
      title: IntegrationMutationErrorTitle.RotateInbound,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useRotateIntegrationInbound(), {
          wrapper,
        });
        return () => result.current.mutateAsync(JIRA_CONNECTION_ID);
      },
    },
  ])("toasts '$title' with the server's message", async ({ title, render }) => {
    const message = "The connection is used by 2 workflows";
    const error = new ApiError(message, 409);
    mockApiClient.patch.mockRejectedValue(error);
    mockApiClient.delete.mockRejectedValue(error);
    mockApiClient.post.mockRejectedValue(error);
    const { wrapper } = setupWithAppClient();
    const mutate = render(wrapper);

    await act(async () => {
      await mutate().catch(() => undefined);
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(title, {
      description: message,
    });
  });
});
