import {
  IntegrationFieldKind,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  jiraConnection,
  jiraProvider,
  PROVIDERS,
  teamsConnection,
} from "../../../integrations/__tests__/integration-fixtures";
import { ProjectConnectionsPanel } from "../project-connections-panel";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const PC_ID = "0199a5f0-0000-7000-8000-0000000000c1";
const ONLY_ADMINS_RE = /Only organization admins can see and change/;
const JIRA_PROJECTS_RE = /Jira projects: BIL, OPS/;
const KEY_RESERVED_RE = /reserved/;
const JIRA_PROJECTS_LABEL_RE = /^Jira projects/;
const QC_CONNECTION_ID = "0199a5f0-0000-7000-8000-0000000000f9";
const ALREADY_IN_PROJECT_RE = /already in this project/;
const ACME_JIRA_TAKEN_RE = /^Acme Jira ?\(already in this project\)$/;

const JIRA_WITH_PROJECTS: IntegrationProviderSummary = {
  ...jiraProvider,
  projectSettingsFields: [
    {
      key: "projectKeys",
      label: "Jira projects",
      kind: IntegrationFieldKind.StringList,
      required: true,
    },
  ],
};

const mocks = vi.hoisted(() => ({
  projectConnections: [] as ProjectConnection[],
  listOptions: [] as Array<{ enabled?: boolean }>,
  addMutate: vi.fn(),
  updateMutate: vi.fn(),
  removeMutate: vi.fn(),
}));

vi.mock("../../hooks/use-project-connections", () => ({
  ProjectConnectionMutationErrorTitle: {
    Add: "Couldn't add the connection",
    Update: "Couldn't save the connection",
    Remove: "Couldn't remove the connection",
  },
  useProjectConnections: (
    _projectId: string,
    options: { enabled?: boolean }
  ) => {
    mocks.listOptions.push(options);
    return {
      data: mocks.projectConnections,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useAddProjectConnection: () => ({
    mutate: mocks.addMutate,
    isPending: false,
    error: null,
  }),
  useUpdateProjectConnection: () => ({
    mutate: mocks.updateMutate,
    isPending: false,
    error: null,
  }),
  useRemoveProjectConnection: () => ({
    mutate: mocks.removeMutate,
    isPending: false,
  }),
}));

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({
    data: [JIRA_WITH_PROJECTS, ...PROVIDERS.slice(1)],
    isLoading: false,
  }),
  useIntegrationConnections: () => ({
    data: [
      jiraConnection,
      { ...jiraConnection, id: QC_CONNECTION_ID, name: "Jira QC bot" },
      teamsConnection,
    ],
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
  mocks.projectConnections = [];
  mocks.listOptions = [];
});

describe("ProjectConnectionsPanel", () => {
  it("tells members only admins see the connections and fetches nothing", () => {
    render(<ProjectConnectionsPanel isAdmin={false} projectId={PROJECT_ID} />);

    expect(screen.getByText(ONLY_ADMINS_RE)).toBeInTheDocument();
    expect(mocks.listOptions).toEqual([{ enabled: false }]);
  });

  it("lists each project connection with its key, connection and settings", () => {
    mocks.projectConnections = [projectConnection()];

    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    const [row] = screen.getAllByTestId("project-connection-row");
    expect(within(row).getByText("jira-billing")).toBeInTheDocument();
    expect(within(row).getByText(JIRA_PROJECTS_RE)).toBeInTheDocument();
  });

  it("adds a connection with a key suggested from its name", async () => {
    const user = userEvent.setup();
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.click(screen.getByRole("checkbox", { name: "Acme Jira" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Jira Billing");
    await user.type(
      screen.getByLabelText(JIRA_PROJECTS_LABEL_RE),
      "BIL{Enter}"
    );
    await user.click(screen.getByRole("button", { name: "Add connection" }));

    expect(screen.getByLabelText("Key")).toHaveValue("jira-billing");
    expect(mocks.addMutate).toHaveBeenCalledWith(
      {
        connections: [
          {
            connectionId: JIRA_CONNECTION_ID,
            key: "jira-billing",
            name: "Jira Billing",
          },
        ],
        settings: { projectKeys: ["BIL"] },
      },
      expect.anything()
    );
  });

  it("adds several bots of one integration with the same settings", async () => {
    const user = userEvent.setup();
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.click(screen.getByRole("checkbox", { name: "Acme Jira" }));
    await user.click(screen.getByRole("checkbox", { name: "Jira QC bot" }));
    expect(
      screen.getByRole("checkbox", { name: "Delivery channel" })
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText(JIRA_PROJECTS_LABEL_RE),
      "BIL{Enter}"
    );
    await user.click(screen.getByRole("button", { name: "Add connections" }));

    expect(mocks.addMutate).toHaveBeenCalledWith(
      {
        connections: [
          {
            connectionId: JIRA_CONNECTION_ID,
            key: "acme-jira",
            name: "Acme Jira",
          },
          {
            connectionId: QC_CONNECTION_ID,
            key: "jira-qc-bot",
            name: "Jira QC bot",
          },
        ],
        settings: { projectKeys: ["BIL"] },
      },
      expect.anything()
    );
  });

  it("does not offer a connection the project already uses", async () => {
    const user = userEvent.setup();
    mocks.projectConnections = [projectConnection()];
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Add connection" }));

    expect(
      screen.getByRole("checkbox", { name: ACME_JIRA_TAKEN_RE })
    ).toBeDisabled();
    expect(screen.getByText(ALREADY_IN_PROJECT_RE)).toBeInTheDocument();
  });

  it("refuses a reserved key before submitting", async () => {
    const user = userEvent.setup();
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.click(screen.getByRole("checkbox", { name: "Acme Jira" }));
    const key = screen.getByLabelText("Key");
    await user.clear(key);
    await user.type(key, "source");
    await user.type(
      screen.getByLabelText(JIRA_PROJECTS_LABEL_RE),
      "BIL{Enter}"
    );
    await user.click(screen.getByRole("button", { name: "Add connection" }));

    expect(screen.getByText(KEY_RESERVED_RE)).toBeInTheDocument();
    expect(mocks.addMutate).not.toHaveBeenCalled();
  });

  it("edits the name and settings without changing the key", async () => {
    const user = userEvent.setup();
    mocks.projectConnections = [projectConnection()];
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(screen.getByRole("button", { name: "Edit Jira billing" }));
    expect(screen.getByLabelText("Key")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateMutate).toHaveBeenCalledWith(
      {
        id: PC_ID,
        input: {
          name: "Jira billing",
          settings: { projectKeys: ["BIL", "OPS"] },
        },
      },
      expect.anything()
    );
  });

  it("removes a project connection", async () => {
    const user = userEvent.setup();
    mocks.projectConnections = [projectConnection()];
    render(<ProjectConnectionsPanel isAdmin projectId={PROJECT_ID} />);

    await user.click(
      screen.getByRole("button", { name: "Remove Jira billing" })
    );

    expect(mocks.removeMutate).toHaveBeenCalledWith(PC_ID);
  });
});

function projectConnection(
  overrides: Partial<ProjectConnection> = {}
): ProjectConnection {
  return {
    id: PC_ID,
    projectId: PROJECT_ID,
    connectionId: JIRA_CONNECTION_ID,
    connectionName: "Acme Jira",
    provider: jiraProvider.key,
    key: "jira-billing",
    name: "Jira billing",
    settings: { projectKeys: ["BIL", "OPS"] },
    createdAt: new Date("2026-10-13T00:00:00Z"),
    updatedAt: new Date("2026-10-13T00:00:00Z"),
    ...overrides,
  };
}
