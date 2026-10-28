import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectSearchParam } from "../create-project-param";
import ProjectsPage from "../page";

const mockReplace = vi.fn();
const mockNavigate = vi.fn();
let mockSearch = "";

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({ data: [], isLoading: false, error: null }),
  useCreateProject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteProject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProjectAssignee: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProjectPriority: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProjectStatus: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProjectTargetDate: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mockNavigate, replace: mockReplace }),
}));
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(mockSearch),
}));
vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/test-org/projects",
}));
vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "test-org" }));

vi.mock("../components/create-project-modal", () => ({
  CreateProjectModal: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-open={String(open)} data-testid="create-modal">
      <button onClick={() => onOpenChange(false)} type="button">
        close-modal
      </button>
    </div>
  ),
}));
vi.mock("../components/projects-table", () => ({
  ProjectsTable: () => <div />,
}));
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div />,
}));

const createParam = `${CreateProjectSearchParam.Key}=${CreateProjectSearchParam.Open}`;

describe("ProjectsPage create deep link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
  });
  afterEach(cleanup);

  it("opens the modal and clears the param when requested", () => {
    mockSearch = `${createParam}&foo=bar`;
    render(<ProjectsPage />);

    expect(screen.getByTestId("create-modal").dataset.open).toBe("true");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/test-org/projects?foo=bar", {
      scroll: false,
    });
  });

  it("replaces with the bare path when create is the only param", () => {
    mockSearch = createParam;
    render(<ProjectsPage />);

    expect(mockReplace).toHaveBeenCalledWith("/test-org/projects", {
      scroll: false,
    });
  });

  it("stays closed without the param", () => {
    render(<ProjectsPage />);

    expect(screen.getByTestId("create-modal").dataset.open).toBe("false");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("clears the param when the modal closes while it is still present", () => {
    mockSearch = createParam;
    render(<ProjectsPage />);
    mockReplace.mockClear();

    fireEvent.click(screen.getByText("close-modal"));

    expect(screen.getByTestId("create-modal").dataset.open).toBe("false");
    expect(mockReplace).toHaveBeenCalledWith("/test-org/projects", {
      scroll: false,
    });
  });
});
