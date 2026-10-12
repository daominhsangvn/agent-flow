import {
  type SaveWorkflowInput,
  type WorkflowActionRun,
  WorkflowActionRunStatus,
  WorkflowRunStatus,
  type WorkflowRunsResponse,
} from "@repo/api/src/types/workflow";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../../integrations/__tests__/integration-fixtures";
import {
  ACTION_RUN_ID,
  makeRunDetail,
  makeRunSummary,
  makeWorkflow,
  RUN_ID,
  TRIGGER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import {
  toSaveWorkflowInput,
  workflowToFormValues,
} from "../../lib/workflow-form";
import { WorkflowMutationErrorTitle } from "../../lib/workflow-labels";
import {
  flattenRunPages,
  isFinalWorkflowRunStatus,
  useCancelWorkflowRun,
  useCreateWorkflow,
  useDeleteWorkflow,
  useOrgWorkflowRuns,
  useRetryWorkflowActionRun,
  useSetWorkflowEnabled,
  useStartWorkflowRun,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflows,
  WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS,
  WORKFLOW_RUN_POLL_INTERVAL_MS,
  WORKFLOW_RUNS_PAGE_SIZE,
} from "../use-workflows";
import { workflowKeys } from "../workflow-keys";

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

const WORKFLOW_PATH = `/workflows/${WORKFLOW_ID}`;
const RUN_PATH = `/workflow-runs/${RUN_ID}`;

function saveInput(): SaveWorkflowInput {
  return toSaveWorkflowInput(workflowToFormValues(makeWorkflow()), PROVIDERS);
}

/** The fixture's post action run, in the given delivery state. */
function postActionRun(status: WorkflowActionRunStatus): WorkflowActionRun {
  const [postRun] = makeRunDetail().actionRuns;
  if (!postRun) {
    throw new Error("The fixture run must have a post action run");
  }
  return { ...postRun, status };
}

function setup() {
  const queryClient = createTestQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const setData = vi.spyOn(queryClient, "setQueryData");
  return {
    queryClient,
    invalidate,
    setData,
    wrapper: createWrapperWithClient(queryClient),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("workflowKeys", () => {
  it("nests every run read under runs()", () => {
    const runs = workflowKeys.runs();
    expect(workflowKeys.workflowRuns(WORKFLOW_ID).slice(0, 2)).toEqual(runs);
    expect(workflowKeys.orgRuns().slice(0, 2)).toEqual(runs);
    expect(workflowKeys.runDetail(RUN_ID).slice(0, 2)).toEqual(runs);
  });
});

describe("workflow queries", () => {
  it("lists workflows and reads one", async () => {
    const workflow = makeWorkflow();
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/workflows" ? { workflows: [workflow] } : workflow
      )
    );
    const { wrapper } = setup();
    const list = renderHook(() => useWorkflows(), { wrapper });
    const detail = renderHook(() => useWorkflow(WORKFLOW_ID), { wrapper });

    await waitFor(() => expect(list.result.current.data).toEqual([workflow]));
    await waitFor(() => expect(detail.result.current.data).toEqual(workflow));
    expect(mockApiClient.get).toHaveBeenCalledWith(WORKFLOW_PATH);
  });

  it("pages a workflow's run history by cursor", async () => {
    const firstPage: WorkflowRunsResponse = {
      runs: [makeRunSummary({ status: WorkflowRunStatus.Succeeded })],
      nextCursor: "cursor-2",
    };
    const secondPage: WorkflowRunsResponse = {
      runs: [makeRunSummary({ id: "run-2", status: WorkflowRunStatus.Failed })],
      nextCursor: null,
    };
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRuns(WORKFLOW_ID), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenLastCalledWith(
      `${WORKFLOW_PATH}/runs?limit=${WORKFLOW_RUNS_PAGE_SIZE}`
    );
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    expect(mockApiClient.get).toHaveBeenLastCalledWith(
      `${WORKFLOW_PATH}/runs?cursor=cursor-2&limit=${WORKFLOW_RUNS_PAGE_SIZE}`
    );
    await waitFor(() =>
      expect(flattenRunPages(result.current.data).map((run) => run.id)).toEqual(
        [RUN_ID, "run-2"]
      )
    );
    expect(result.current.hasNextPage).toBe(false);
  });

  it("reads the org-wide run history with a status filter", async () => {
    mockApiClient.get.mockResolvedValue({ runs: [], nextCursor: null });
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useOrgWorkflowRuns({ status: WorkflowRunStatus.Failed, limit: 10 }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/workflow-runs?limit=10&status=${WorkflowRunStatus.Failed}`
    );
  });
});

describe("run detail polling", () => {
  it("polls an active run and stops once it is final with every action settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiClient.get
      .mockResolvedValueOnce(
        makeRunDetail({ status: WorkflowRunStatus.Planning })
      )
      .mockResolvedValue(
        makeRunDetail({
          status: WorkflowRunStatus.Succeeded,
          actionRuns: [postActionRun(WorkflowActionRunStatus.Failed)],
        })
      );
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun(RUN_ID), { wrapper });

    await waitFor(() =>
      expect(result.current.data?.status).toBe(WorkflowRunStatus.Planning)
    );
    expect(mockApiClient.get).toHaveBeenCalledWith(RUN_PATH);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(result.current.data?.status).toBe(WorkflowRunStatus.Succeeded)
    );
    const callsAfterFinal = mockApiClient.get.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS * 3);
    });
    expect(mockApiClient.get.mock.calls.length).toBe(callsAfterFinal);
  });

  it("keeps polling a final run, more slowly, while post actions are still pending or running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiClient.get
      .mockResolvedValueOnce(
        makeRunDetail({
          status: WorkflowRunStatus.Succeeded,
          actionRuns: [postActionRun(WorkflowActionRunStatus.Pending)],
        })
      )
      .mockResolvedValueOnce(
        makeRunDetail({
          status: WorkflowRunStatus.Succeeded,
          actionRuns: [postActionRun(WorkflowActionRunStatus.Running)],
        })
      )
      .mockResolvedValue(
        makeRunDetail({
          status: WorkflowRunStatus.Succeeded,
          actionRuns: [postActionRun(WorkflowActionRunStatus.Succeeded)],
        })
      );
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun(RUN_ID), { wrapper });

    await waitFor(() =>
      expect(result.current.data?.actionRuns[0]?.status).toBe(
        WorkflowActionRunStatus.Pending
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(result.current.data?.actionRuns[0]?.status).toBe(
        WorkflowActionRunStatus.Running
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(result.current.data?.actionRuns[0]?.status).toBe(
        WorkflowActionRunStatus.Succeeded
      )
    );
    const callsAfterSettled = mockApiClient.get.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        WORKFLOW_RUN_ACTIONS_POLL_INTERVAL_MS * 3
      );
    });
    expect(mockApiClient.get.mock.calls.length).toBe(callsAfterSettled);
  });

  it("does not keep polling a run that failed to load", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiClient.get.mockRejectedValue(new Error("not found"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun(RUN_ID), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const calls = mockApiClient.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_INTERVAL_MS * 3);
    });
    expect(mockApiClient.get.mock.calls.length).toBe(calls);
  });

  it("classifies final statuses from the contract", () => {
    expect(isFinalWorkflowRunStatus(WorkflowRunStatus.Cancelled)).toBe(true);
    expect(isFinalWorkflowRunStatus(WorkflowRunStatus.NeedsInput)).toBe(false);
  });
});

describe("workflow mutations", () => {
  it("creates with POST, caches the detail and refreshes the list", async () => {
    const workflow = makeWorkflow();
    mockApiClient.post.mockResolvedValue(workflow);
    const { wrapper, invalidate, setData } = setup();
    const { result } = renderHook(() => useCreateWorkflow(), { wrapper });
    const input = saveInput();

    await act(() => result.current.mutateAsync(input));

    expect(mockApiClient.post).toHaveBeenCalledWith("/workflows", input);
    expect(setData).toHaveBeenCalledWith(
      workflowKeys.detail(WORKFLOW_ID),
      workflow
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.lists() });
  });

  it("updates with PUT", async () => {
    const workflow = makeWorkflow();
    mockApiClient.put.mockResolvedValue(workflow);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useUpdateWorkflow(), { wrapper });
    const input = saveInput();

    await act(() => result.current.mutateAsync({ id: WORKFLOW_ID, input }));

    expect(mockApiClient.put).toHaveBeenCalledWith(WORKFLOW_PATH, input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.lists() });
  });

  it("deletes with DELETE and refreshes lists and runs", async () => {
    mockApiClient.delete.mockResolvedValue({ deleted: true });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteWorkflow(), { wrapper });

    await act(() => result.current.mutateAsync(WORKFLOW_ID));

    expect(mockApiClient.delete).toHaveBeenCalledWith(WORKFLOW_PATH);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.runs() });
  });

  it("starts a manual run for a trigger", async () => {
    mockApiClient.post.mockResolvedValue(makeRunSummary());
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useStartWorkflowRun(), { wrapper });
    const input = { triggerId: TRIGGER_ID, input: "PROJ-7" };

    await act(() =>
      result.current.mutateAsync({ workflowId: WORKFLOW_ID, input })
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${WORKFLOW_PATH}/runs`,
      input
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.runs() });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workflowKeys.detail(WORKFLOW_ID),
    });
  });

  it("cancels a run, caches the returned detail and refetches it", async () => {
    const cancelled = makeRunDetail({ status: WorkflowRunStatus.Cancelled });
    mockApiClient.post.mockResolvedValue(cancelled);
    const { wrapper, invalidate, setData } = setup();
    const { result } = renderHook(() => useCancelWorkflowRun(), { wrapper });

    await act(() => result.current.mutateAsync(RUN_ID));

    expect(mockApiClient.post).toHaveBeenCalledWith(`${RUN_PATH}/cancel`, {});
    expect(setData).toHaveBeenCalledWith(
      workflowKeys.runDetail(RUN_ID),
      cancelled
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workflowKeys.runDetail(RUN_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...workflowKeys.runs(), "workflow", WORKFLOW_ID],
    });
  });

  it("retries an action run, then refetches the run and its lists to show the delivery", async () => {
    const detail = makeRunDetail({
      status: WorkflowRunStatus.Succeeded,
      actionRuns: [postActionRun(WorkflowActionRunStatus.Pending)],
    });
    mockApiClient.post.mockResolvedValue(detail);
    const { wrapper, invalidate, setData } = setup();
    const { result } = renderHook(() => useRetryWorkflowActionRun(), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({ runId: RUN_ID, actionRunId: ACTION_RUN_ID })
    );

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${RUN_PATH}/action-runs/${ACTION_RUN_ID}/retry`,
      {}
    );
    expect(setData).toHaveBeenCalledWith(
      workflowKeys.runDetail(RUN_ID),
      detail
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workflowKeys.runDetail(RUN_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...workflowKeys.runs(), "workflow", WORKFLOW_ID],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...workflowKeys.runs(), "org"],
    });
  });

  it("turns a workflow on or off with PATCH, without re-sending it", async () => {
    const disabled = makeWorkflow({ enabled: false });
    mockApiClient.patch.mockResolvedValue(disabled);
    const { wrapper, invalidate, setData } = setup();
    const { result } = renderHook(() => useSetWorkflowEnabled(), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        id: WORKFLOW_ID,
        input: { enabled: false },
      })
    );

    expect(mockApiClient.patch).toHaveBeenCalledWith(WORKFLOW_PATH, {
      enabled: false,
    });
    expect(mockApiClient.put).not.toHaveBeenCalled();
    expect(setData).toHaveBeenCalledWith(
      workflowKeys.detail(WORKFLOW_ID),
      disabled
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowKeys.lists() });
  });
});

describe("workflow mutation errors", () => {
  type Wrapper = ReturnType<typeof createWrapperWithClient>;

  /** The app's real QueryClient, whose default mutation toast only knows error codes. */
  function appWrapper(): Wrapper {
    return createWrapperWithClient(makeQueryClient());
  }

  it.each([
    {
      title: WorkflowMutationErrorTitle.Update,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useUpdateWorkflow(), { wrapper });
        return () =>
          result.current.mutateAsync({ id: WORKFLOW_ID, input: saveInput() });
      },
    },
    {
      title: WorkflowMutationErrorTitle.Create,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useCreateWorkflow(), { wrapper });
        return () => result.current.mutateAsync(saveInput());
      },
    },
    {
      title: WorkflowMutationErrorTitle.SetEnabled,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useSetWorkflowEnabled(), {
          wrapper,
        });
        return () =>
          result.current.mutateAsync({
            id: WORKFLOW_ID,
            input: { enabled: true },
          });
      },
    },
    {
      title: WorkflowMutationErrorTitle.Delete,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useDeleteWorkflow(), { wrapper });
        return () => result.current.mutateAsync(WORKFLOW_ID);
      },
    },
    {
      title: WorkflowMutationErrorTitle.StartRun,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useStartWorkflowRun(), {
          wrapper,
        });
        return () =>
          result.current.mutateAsync({
            workflowId: WORKFLOW_ID,
            input: { triggerId: TRIGGER_ID, input: "PROJ-7" },
          });
      },
    },
    {
      title: WorkflowMutationErrorTitle.CancelRun,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useCancelWorkflowRun(), {
          wrapper,
        });
        return () => result.current.mutateAsync(RUN_ID);
      },
    },
    {
      title: WorkflowMutationErrorTitle.RetryActionRun,
      render: (wrapper: Wrapper) => {
        const { result } = renderHook(() => useRetryWorkflowActionRun(), {
          wrapper,
        });
        return () =>
          result.current.mutateAsync({
            runId: RUN_ID,
            actionRunId: ACTION_RUN_ID,
          });
      },
    },
  ])("toasts '$title' with the server's message instead of the generic failure", async ({
    title,
    render,
  }) => {
    const message = 'Trigger 1: the connection "Acme Jira" is disabled.';
    const error = new ApiError(message, 400);
    mockApiClient.post.mockRejectedValue(error);
    mockApiClient.put.mockRejectedValue(error);
    mockApiClient.patch.mockRejectedValue(error);
    mockApiClient.delete.mockRejectedValue(error);
    const mutate = render(appWrapper());

    await act(async () => {
      await mutate().catch(() => undefined);
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(title, {
      description: message,
    });
  });
});
