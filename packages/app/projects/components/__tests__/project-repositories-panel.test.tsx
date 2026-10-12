import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationProviderKey,
  type IntegrationRepository,
} from "@repo/api/src/types/integration";
import type { ProjectRepository } from "@repo/api/src/types/project-repository";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  jiraConnection,
  makeConnection,
  PROVIDERS,
} from "../../../integrations/__tests__/integration-fixtures";
import { ProjectRepositoriesPanel } from "../project-repositories-panel";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const ONLY_ADMINS_RE = /Only organization admins can change them/;
const GITHUB_CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const LOCAL_GIT_CONNECTION_ID = "66666666-6666-4666-8666-666666666666";
const CONTOSO_GITHUB_RE = /Contoso GitHub/;
const LOCAL_GIT_RE = /Local Git/;

const GITHUB_PROVIDER = {
  ...PROVIDERS[0],
  key: IntegrationProviderKey.GitHub,
  displayName: "GitHub",
  triggers: [],
  actions: [],
  deliveryModes: [],
  capabilities: ["actions" as const, "repositories" as const],
};

const githubConnection: IntegrationConnection = makeConnection({
  id: GITHUB_CONNECTION_ID,
  provider: IntegrationProviderKey.GitHub,
  name: "Contoso GitHub",
});

const LOCAL_GIT_PROVIDER = {
  ...GITHUB_PROVIDER,
  key: IntegrationProviderKey.LocalGit,
  displayName: "Local Git",
  capabilities: [
    "actions" as const,
    "repositories" as const,
    "repository_creation" as const,
  ],
};

const localGitConnection: IntegrationConnection = makeConnection({
  id: LOCAL_GIT_CONNECTION_ID,
  provider: IntegrationProviderKey.LocalGit,
  name: "Local Git",
});

function projectRepository(
  overrides: Partial<ProjectRepository> = {}
): ProjectRepository {
  return {
    id: "repo-1",
    projectId: PROJECT_ID,
    connectionId: GITHUB_CONNECTION_ID,
    connectionName: "Contoso GitHub",
    provider: IntegrationProviderKey.GitHub,
    externalId: "1296269",
    fullName: "contoso/shop",
    name: "shop",
    defaultBranch: "main",
    webUrl: "https://github.com/contoso/shop",
    isPrimary: true,
    createdAt: new Date("2026-10-05T00:00:00Z"),
    updatedAt: new Date("2026-10-05T00:00:00Z"),
    ...overrides,
  };
}

const available: IntegrationRepository[] = [
  {
    externalId: "1296269",
    fullName: "contoso/shop",
    name: "shop",
    namespace: "contoso",
    defaultBranch: "main",
    webUrl: "https://github.com/contoso/shop",
    isPrivate: true,
  },
  {
    externalId: "1296270",
    fullName: "contoso/api",
    name: "api",
    namespace: "contoso",
    defaultBranch: "main",
    webUrl: "https://github.com/contoso/api",
    isPrivate: false,
  },
];

const mocks = vi.hoisted(() => ({
  repositories: [] as ProjectRepository[],
  connections: [] as IntegrationConnection[],
  available: [] as IntegrationRepository[],
  availableCalls: [] as Array<{ connectionId: string; query: string }>,
  addMutate: vi.fn(),
  removeMutate: vi.fn(),
  createMutateAsync: vi.fn(),
  createdFor: [] as string[],
}));

vi.mock("../../hooks/use-project-repositories", () => ({
  useProjectRepositories: () => ({
    data: mocks.repositories,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useConnectionRepositories: (connectionId: string, query: string) => {
    mocks.availableCalls.push({ connectionId, query });
    return {
      data: mocks.available,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useAddProjectRepository: () => ({
    mutate: mocks.addMutate,
    isPending: false,
  }),
  useRemoveProjectRepository: () => ({
    mutate: mocks.removeMutate,
    isPending: false,
  }),
  useCreateConnectionRepository: (connectionId: string) => {
    mocks.createdFor.push(connectionId);
    return { mutateAsync: mocks.createMutateAsync, isPending: false };
  },
}));

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({
    data: [...PROVIDERS, GITHUB_PROVIDER, LOCAL_GIT_PROVIDER],
    isLoading: false,
  }),
  useIntegrationConnections: () => ({
    data: mocks.connections,
    isLoading: false,
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repositories = [];
  mocks.connections = [jiraConnection, githubConnection];
  mocks.available = available;
  mocks.availableCalls = [];
  mocks.createdFor = [];
});

describe("ProjectRepositoriesPanel", () => {
  it("lists every repository as an equal, with no primary", () => {
    mocks.repositories = [
      projectRepository(),
      projectRepository({
        id: "repo-2",
        externalId: "1296270",
        fullName: "contoso/api",
        isPrimary: false,
      }),
    ];

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);

    const rows = screen.getAllByTestId("project-repository-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("contoso/shop")).toHaveAttribute(
      "href",
      "https://github.com/contoso/shop"
    );
    expect(screen.queryByText("Primary")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Make primary" })
    ).not.toBeInTheDocument();
  });

  it("removes a repository", async () => {
    const user = userEvent.setup();
    mocks.repositories = [
      projectRepository(),
      projectRepository({
        id: "repo-2",
        externalId: "1296270",
        fullName: "contoso/api",
        isPrimary: false,
      }),
    ];

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(
      screen.getByRole("button", { name: "Remove contoso/shop" })
    );

    expect(mocks.removeMutate).toHaveBeenCalledWith("repo-1");
  });

  it("says when a repository lost its connection", () => {
    mocks.repositories = [
      projectRepository({ connectionId: null, connectionName: null }),
    ];

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);

    expect(
      screen.getByText(
        "Connection removed: remove this repository and add it again"
      )
    ).toBeInTheDocument();
  });

  it("adds a repository from a connection that offers repositories", async () => {
    const user = userEvent.setup();
    mocks.repositories = [projectRepository()];

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await user.click(screen.getByRole("combobox", { name: "Connection" }));

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Contoso GitHub",
    ]);
    await user.click(screen.getByRole("option", { name: CONTOSO_GITHUB_RE }));

    const rows = screen.getAllByTestId("available-repository-row");
    expect(
      within(rows[0]).getByRole("button", { name: "Add contoso/shop" })
    ).toBeDisabled();
    await user.click(
      within(rows[1]).getByRole("button", { name: "Add contoso/api" })
    );
    expect(mocks.addMutate).toHaveBeenCalledWith({
      connectionId: GITHUB_CONNECTION_ID,
      externalId: "1296270",
    });

    await user.type(
      screen.getByRole("textbox", { name: "Search repositories" }),
      " api "
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(mocks.availableCalls.at(-1)).toEqual({
      connectionId: GITHUB_CONNECTION_ID,
      query: "api",
    });
  });

  it("offers no new repository for connections that only list them", async () => {
    const user = userEvent.setup();

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await user.click(screen.getByRole("combobox", { name: "Connection" }));
    await user.click(screen.getByRole("option", { name: CONTOSO_GITHUB_RE }));

    expect(
      screen.queryByTestId("create-repository-form")
    ).not.toBeInTheDocument();
  });

  it("creates a repository in Local Git and adds it to the project", async () => {
    const user = userEvent.setup();
    mocks.connections = [githubConnection, localGitConnection];
    mocks.createMutateAsync.mockResolvedValue({
      externalId: "12",
      fullName: "agentflow/notes",
      name: "notes",
      namespace: "agentflow",
      defaultBranch: "main",
      webUrl: "http://localhost:3300/agentflow/notes",
      isPrivate: true,
    });

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await user.click(screen.getByRole("combobox", { name: "Connection" }));
    await user.click(screen.getByRole("option", { name: LOCAL_GIT_RE }));

    const form = screen.getByTestId("create-repository-form");
    const submit = within(form).getByRole("button", { name: "Create and add" });
    expect(submit).toBeDisabled();
    await user.type(
      within(form).getByRole("textbox", { name: "New repository name" }),
      " notes "
    );
    await user.click(submit);

    expect(mocks.createdFor.at(-1)).toBe(LOCAL_GIT_CONNECTION_ID);
    expect(mocks.createMutateAsync).toHaveBeenCalledWith({ name: "notes" });
    expect(mocks.addMutate).toHaveBeenCalledWith(
      { connectionId: LOCAL_GIT_CONNECTION_ID, externalId: "12" },
      expect.anything()
    );
  });

  it("adds nothing when creating the repository failed", async () => {
    const user = userEvent.setup();
    mocks.connections = [localGitConnection];
    mocks.createMutateAsync.mockRejectedValue(new Error("already exists"));

    render(<ProjectRepositoriesPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await user.click(screen.getByRole("combobox", { name: "Connection" }));
    await user.click(screen.getByRole("option", { name: LOCAL_GIT_RE }));
    const form = screen.getByTestId("create-repository-form");
    await user.type(
      within(form).getByRole("textbox", { name: "New repository name" }),
      "notes"
    );
    await user.click(
      within(form).getByRole("button", { name: "Create and add" })
    );

    expect(mocks.createMutateAsync).toHaveBeenCalled();
    expect(mocks.addMutate).not.toHaveBeenCalled();
  });

  it("points at Settings when no connection offers repositories", async () => {
    const user = userEvent.setup();
    mocks.connections = [
      jiraConnection,
      makeConnection({
        id: "55555555-5555-4555-8555-555555555555",
        provider: IntegrationProviderKey.GitHub,
        name: "Disabled GitHub",
        status: IntegrationConnectionStatus.Disabled,
      }),
    ];

    render(
      <ProjectRepositoriesPanel
        connectionsSettingsPath="/settings?tab=integrations"
        isAdmin
        projectId={PROJECT_ID}
      />
    );
    await user.click(screen.getByRole("button", { name: "Add repository" }));

    expect(
      screen.getByRole("link", { name: "Manage connections" })
    ).toHaveAttribute("href", "/acme/settings?tab=integrations");
    expect(mocks.connections[0]?.id).toBe(JIRA_CONNECTION_ID);
  });

  it("shows members the repositories without add or remove", () => {
    mocks.repositories = [projectRepository()];

    render(<ProjectRepositoriesPanel isAdmin={false} projectId={PROJECT_ID} />);

    expect(screen.getByTestId("project-repository-row")).toHaveTextContent(
      "contoso/shop"
    );
    expect(
      screen.queryByRole("button", { name: "Add repository" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove contoso/shop" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(ONLY_ADMINS_RE)).toBeVisible();
  });
});
