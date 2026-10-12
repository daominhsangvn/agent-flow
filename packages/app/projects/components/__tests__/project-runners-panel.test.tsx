import type { ProjectRunner } from "@repo/api/src/types/project-runners";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRunnersPanel } from "../project-runners-panel";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const ONLY_ADMINS_RE = /Only organization admins can change them/;
const DOTNET = "0199a5f0-0000-7000-8000-0000000000c1";
const NODE = "0199a5f0-0000-7000-8000-0000000000c2";
const SPARE = "0199a5f0-0000-7000-8000-0000000000c3";

const mocks = vi.hoisted(() => ({
  runners: [] as ProjectRunner[],
  computers: [] as Array<{
    id: string;
    machineName: string;
    isOnline: boolean;
  }>,
  saveMutate: vi.fn(),
}));

vi.mock("../../hooks/use-project-runners", () => ({
  useProjectRunners: () => ({
    data: mocks.runners,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveProjectRunners: () => ({
    mutate: mocks.saveMutate,
    isPending: false,
  }),
  useAssignableComputers: () => ({
    data: mocks.computers,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function runner(id: string, overrides: Partial<ProjectRunner> = {}) {
  return {
    id,
    machineName: `runner-${id.slice(-2)}`,
    isOnline: true,
    isSharedWithOrg: true,
    ownerName: "Ops Team",
    capacity: 2,
    activeLoops: 1,
    tools: {},
    ...overrides,
  } satisfies ProjectRunner;
}

beforeEach(() => {
  mocks.runners = [
    runner(DOTNET, {
      tools: { git: "git version 2.39.5", python3: "Python 3.11.2" },
    }),
    runner(NODE, {
      isOnline: false,
      isSharedWithOrg: false,
      capacity: null,
      activeLoops: 0,
    }),
  ];
  mocks.computers = [
    { id: DOTNET, machineName: "runner-c1", isOnline: true },
    { id: SPARE, machineName: "spare-box", isOnline: false },
  ];
  mocks.saveMutate.mockReset();
});

describe("ProjectRunnersPanel", () => {
  it("lists each runner with its status, load, owner and tools", () => {
    render(<ProjectRunnersPanel isAdmin projectId={PROJECT_ID} />);

    const [dotnet, node] = screen.getAllByTestId("project-runner-row");
    expect(dotnet).toHaveTextContent(
      "Online · 1 of 2 loops running · Ops Team"
    );
    expect(
      within(dotnet).getByRole("list", { name: "Reported tools" })
    ).toHaveTextContent("gitpython3");
    expect(node).toHaveTextContent("Offline · 0 loops running · Ops Team");
    expect(node).toHaveTextContent("Not shared with the organization");
  });

  it("removes a runner by saving the others", async () => {
    const user = userEvent.setup();
    render(<ProjectRunnersPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Remove runner-c1" }));

    expect(mocks.saveMutate).toHaveBeenCalledWith({ runnerIds: [NODE] });
  });

  it("offers only computers that are not runners yet", async () => {
    const user = userEvent.setup();
    render(<ProjectRunnersPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Add runner" }));
    await user.click(screen.getByRole("combobox", { name: "Computer" }));

    expect(
      screen.getByRole("option", { name: "spare-box (offline)" })
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: "runner-c1" })).toBeNull();
  });

  it("explains where loops run without runners", () => {
    mocks.runners = [];
    render(<ProjectRunnersPanel isAdmin projectId={PROJECT_ID} />);

    expect(
      screen.getByText(
        "No runners yet: loops run on the computer each user picks."
      )
    ).toBeVisible();
  });

  it("shows members the runners without add or remove", () => {
    render(<ProjectRunnersPanel isAdmin={false} projectId={PROJECT_ID} />);

    expect(screen.getAllByTestId("project-runner-row")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Add runner" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove runner-c1" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(ONLY_ADMINS_RE)).toBeVisible();
  });
});
