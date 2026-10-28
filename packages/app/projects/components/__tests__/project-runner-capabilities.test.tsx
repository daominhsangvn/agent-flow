import {
  type ComputeTargetCapabilities,
  RunnerCapabilitiesRefreshStatus,
  RunnerCapabilitiesSource,
} from "@repo/api/src/types/runner-capabilities";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRunnerCapabilities } from "../project-runner-capabilities";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const TARGET_ID = "0199a5f0-0000-7000-8000-0000000000c1";

const mocks = vi.hoisted(() => ({
  files: [] as unknown[],
  requestMutate: vi.fn(),
  refreshData: undefined as unknown,
}));

vi.mock("../../hooks/use-project-runner-capabilities", () => ({
  useProjectRunnerCapabilities: () => ({
    data: mocks.files,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../hooks/use-project-runners", () => ({
  useAssignableComputers: () => ({
    data: [{ id: TARGET_ID, machineName: "runner-1" }],
  }),
}));
vi.mock("../../hooks/use-project-repositories", () => ({
  useProjectRepositories: () => ({
    data: [{ id: "r1", fullName: "workshop/kit" }],
  }),
}));
vi.mock("../../hooks/use-runner-capabilities-refresh", () => ({
  useRequestRunnerCapabilitiesRefresh: () => ({
    mutate: mocks.requestMutate,
    isPending: false,
  }),
  useRunnerCapabilitiesRefresh: () => ({ data: mocks.refreshData }),
}));

function file(source: RunnerCapabilitiesSource): ComputeTargetCapabilities {
  return {
    id: `file-${source}`,
    computeTargetId: TARGET_ID,
    runnerName: "runner-1",
    isOnline: true,
    projectId: PROJECT_ID,
    source,
    content: "",
    capabilities: null,
    problems: [],
    warnings: [],
    contentHash: "h",
    uploadedAt: "2026-10-26T00:00:00.000Z",
  };
}

async function open() {
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
}

beforeEach(() => {
  mocks.files = [file(RunnerCapabilitiesSource.Toolkit)];
  mocks.requestMutate.mockReset();
  mocks.refreshData = undefined;
});

describe("ProjectRunnerCapabilities refresh", () => {
  it("hides Refresh from non-admins", async () => {
    render(
      <ProjectRunnerCapabilities isAdmin={false} projectId={PROJECT_ID} />
    );
    await open();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("refreshes a toolkit row", async () => {
    render(<ProjectRunnerCapabilities isAdmin projectId={PROJECT_ID} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.requestMutate).toHaveBeenCalledWith(
      { computeTargetId: TARGET_ID, project: PROJECT_ID },
      expect.anything()
    );
  });

  it("has no Refresh on a personal row", async () => {
    mocks.files = [file(RunnerCapabilitiesSource.Personal)];
    render(<ProjectRunnerCapabilities isAdmin projectId={PROJECT_ID} />);
    await open();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("renders a failed refresh error", async () => {
    mocks.refreshData = {
      status: RunnerCapabilitiesRefreshStatus.Failed,
      error: "runner-1 is offline.",
      repository: "workshop/kit",
    };
    mocks.requestMutate.mockImplementation((_input, options) =>
      options.onSuccess({ computeTargetId: TARGET_ID, refreshId: "rf" })
    );
    render(<ProjectRunnerCapabilities isAdmin projectId={PROJECT_ID} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "runner-1 is offline."
    );
  });

  it("opens the form behind a button", async () => {
    mocks.files = [];
    render(<ProjectRunnerCapabilities isAdmin projectId={PROJECT_ID} />);
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Read from a runner's toolkit" })
    );
    expect(screen.getByRole("button", { name: "Read" })).toBeDisabled();
  });
});
