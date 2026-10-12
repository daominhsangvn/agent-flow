import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../../integrations/__tests__/integration-fixtures";
import {
  makeRunSummary,
  makeWorkflow,
  RUN_ID,
  TRIGGER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { getManualRunTriggers } from "../../lib/workflow-catalog";
import { WorkflowMutationErrorTitle } from "../../lib/workflow-labels";
import { WorkflowRunNowDialog } from "../workflow-run-now-dialog";

/**
 * The Run now dialog wired to the real start-run hook and the real shared
 * QueryClient (with its default error toast), so a refused run shows what
 * the user actually sees.
 */

const ACTIVE_RUN_MESSAGE = "PROJ-7 already has an active run";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

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

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mocks.navigate,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

function renderDialog() {
  const onClose = vi.fn();
  render(
    <WorkflowRunNowDialog
      onClose={onClose}
      triggers={getManualRunTriggers(PROVIDERS, makeWorkflow().triggers)}
      workflowId={WORKFLOW_ID}
    />,
    { wrapper: createWrapperWithClient(makeQueryClient()) }
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowRunNowDialog", () => {
  it("shows the server's reason inline and in a toast when the run is refused", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockRejectedValue(new ApiError(ACTIVE_RUN_MESSAGE, 409));
    const { onClose } = renderDialog();

    await user.type(screen.getByLabelText("Issue key"), "PROJ-7");
    await user.click(screen.getByRole("button", { name: "Start run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(WorkflowMutationErrorTitle.StartRun);
    expect(alert).toHaveTextContent(ACTIVE_RUN_MESSAGE);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      WorkflowMutationErrorTitle.StartRun,
      { description: ACTIVE_RUN_MESSAGE }
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens the new run when it starts", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue(makeRunSummary());
    const { onClose } = renderDialog();

    await user.type(screen.getByLabelText("Issue key"), "PROJ-7");
    await user.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        `/acme/workflows/${WORKFLOW_ID}/runs/${RUN_ID}`
      )
    );
    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/workflows/${WORKFLOW_ID}/runs`,
      { triggerId: TRIGGER_ID, input: "PROJ-7" }
    );
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
