import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_CLOUD,
  JIRA_CONNECTION_ID,
  jiraConnection,
  makeConnection,
  PROVIDERS,
  serverLocalGitConnection,
  serverLocalGitProvider,
  teamsConnection,
} from "../../__tests__/integration-fixtures";
import { REQUIRED_FIELD_MESSAGE } from "../../lib/integration-field-values";
import { IntegrationConnectionsPanel } from "../integration-connections-panel";

const JIRA_RE = /^Jira/;
const LOCAL_GIT_RE = /^Local Git/;
const TEAMS_RE = /^Microsoft Teams/;

const DELETE_ACME_JIRA_RE = /Delete "Acme Jira"\?/;
const API_TOKEN_RE = /API token/;
const POLL_INTERVAL_RE = /Write a whole number of seconds between 60/;

vi.mock("../connection-yaml-editor", async () => {
  const stub = await import("./connection-yaml-editor.test-helpers");
  return stub.connectionYamlEditorModule;
});

/** Rewrites the dialog's YAML (the editor is a textarea in jsdom). */
async function editYaml(
  dialog: HTMLElement,
  edit: (text: string) => string
): Promise<void> {
  const box = (await within(dialog).findByRole("textbox", {
    name: "Connection YAML",
  })) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: edit(box.value) } });
}

type QueryState<T> = {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
};

type MutationOptions<T> = { onSuccess?: (result: T) => void };

const mocks = vi.hoisted(() => ({
  providers: [] as IntegrationProviderSummary[],
  connections: {
    data: undefined as IntegrationConnection[] | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  deleteMutateAsync: vi.fn(),
  testMutate: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-project-connections", () => ({
  useConnectionProjects: () => ({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({
    data: mocks.providers,
    isLoading: false,
    error: null,
  }),
  useIntegrationConnections: (): QueryState<IntegrationConnection[]> =>
    mocks.connections,
  useCreateIntegrationConnection: () => ({
    mutate: mocks.createMutate,
    isPending: false,
  }),
  useUpdateIntegrationConnection: () => ({
    mutate: mocks.updateMutate,
    isPending: false,
  }),
  useDeleteIntegrationConnection: () => ({
    mutateAsync: mocks.deleteMutateAsync,
    isPending: false,
  }),
  useTestIntegrationConnection: () => ({
    mutate: mocks.testMutate,
    isPending: false,
  }),
  useIntegrationInbound: () => ({
    data: {
      inboundUrl: "https://api.acme.dev/webhooks/integrations/key-1",
      inboundSecret: "s3cret",
      setupInstructions: "Create a webhook in Jira.",
      inboundUrlWarning: null,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useIntegrationDeliveries: () => ({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRotateIntegrationInbound: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

function setConnections(connections: IntegrationConnection[]) {
  mocks.connections.data = connections;
  mocks.connections.isLoading = false;
  mocks.connections.error = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers = PROVIDERS;
  setConnections([]);
});

describe("IntegrationConnectionsPanel states", () => {
  it("shows a loading skeleton", () => {
    mocks.connections.isLoading = true;
    render(<IntegrationConnectionsPanel isAdmin />);
    expect(
      screen.getByRole("status", { name: "Loading connections" })
    ).toBeInTheDocument();
  });

  it("shows an inline error with retry", async () => {
    const user = userEvent.setup();
    mocks.connections.error = new Error("boom");
    render(<IntegrationConnectionsPanel isAdmin />);

    expect(screen.getByText("Couldn't load connections")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.connections.refetch).toHaveBeenCalled();
  });

  it("offers admins an Add connection action in the empty state", () => {
    render(
      <IntegrationConnectionsPanel id="integration-connections" isAdmin />
    );
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Add connection" }).length
    ).toBeGreaterThan(0);
    expect(document.getElementById("integration-connections")).not.toBeNull();
  });

  it("gives members a read-only empty state", () => {
    render(<IntegrationConnectionsPanel isAdmin={false} />);
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add connection" })
    ).not.toBeInTheDocument();
  });
});

describe("IntegrationConnectionsPanel list", () => {
  it("renders each connection's provider, status, account, delivery and last error", () => {
    setConnections([
      makeConnection({
        status: IntegrationConnectionStatus.Error,
        lastError: "401 from Jira",
        usageCount: 2,
      }),
      makeConnection({
        id: "44444444-4444-4444-8444-444444444444",
        name: "DC Jira",
        deliveryMode: IntegrationDeliveryMode.Poll,
        pollIntervalSeconds: 300,
        account: null,
      }),
    ]);
    render(<IntegrationConnectionsPanel isAdmin />);

    const list = screen.getByRole("list", { name: "Integration connections" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first).getByText("Acme Jira")).toBeInTheDocument();
    expect(within(first).getByText("Error")).toBeInTheDocument();
    expect(
      within(first).getByText(
        "Jira · Webhook · as AgentFlow Bot · used by 2 workflow items or projects"
      )
    ).toBeInTheDocument();
    expect(
      within(first).getByText("Last error: 401 from Jira")
    ).toBeInTheDocument();
    expect(
      within(second).getByText("Jira · Polling every 5 min")
    ).toBeInTheDocument();
    expect(within(second).getByText("No deliveries yet")).toBeInTheDocument();
  });

  it("lists the server's default connection without edit or delete, and never offers to add it", async () => {
    const user = userEvent.setup();
    mocks.providers = [...PROVIDERS, serverLocalGitProvider];
    setConnections([jiraConnection, serverLocalGitConnection]);
    render(<IntegrationConnectionsPanel isAdmin />);

    const list = screen.getByRole("list", { name: "Integration connections" });
    const [, localGit] = within(list).getAllByRole("listitem");
    expect(within(localGit).getByText("Default")).toBeInTheDocument();
    expect(
      within(localGit).getByText("Local Git · Actions only · as agentflow")
    ).toBeInTheDocument();
    expect(
      within(localGit).getByText(
        "Provided by the server for every organization; configured in the API's environment."
      )
    ).toBeInTheDocument();
    expect(
      within(localGit).getByRole("button", { name: "Test" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Local Git" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Local Git" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Acme Jira" })
    ).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Add connection" })[0]
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: JIRA_RE })
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: LOCAL_GIT_RE })
    ).not.toBeInTheDocument();
  });

  it("hides admin actions from members but keeps the deliveries view", () => {
    setConnections([jiraConnection, teamsConnection]);
    render(<IntegrationConnectionsPanel isAdmin={false} />);

    expect(
      screen.queryByRole("button", { name: "Test" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Acme Jira" })
    ).not.toBeInTheDocument();
    // Webhook connection: members see deliveries, never the inbound secret.
    expect(
      screen.getByRole("button", { name: "Deliveries" })
    ).toBeInTheDocument();
    // A Teams connection has no inbound side at all.
    expect(screen.getAllByRole("button", { name: "Deliveries" })).toHaveLength(
      1
    );
  });

  it("tests a connection and shows the result", async () => {
    const user = userEvent.setup();
    setConnections([jiraConnection]);
    mocks.testMutate.mockImplementation(
      (_id: string, options: MutationOptions<unknown>) =>
        options.onSuccess?.({
          ok: true,
          account: { externalAccountId: "a", displayName: "AgentFlow Bot" },
          error: null,
        })
    );
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(mocks.testMutate).toHaveBeenCalledWith(
      JIRA_CONNECTION_ID,
      expect.any(Object)
    );
    expect(
      screen.getByText("Connection works. Authenticated as AgentFlow Bot.")
    ).toBeInTheDocument();
  });

  it("shows a failed test's provider message", async () => {
    const user = userEvent.setup();
    setConnections([jiraConnection]);
    mocks.testMutate.mockImplementation(
      (_id: string, options: MutationOptions<unknown>) =>
        options.onSuccess?.({ ok: false, account: null, error: "Bad token" })
    );
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByText("Bad token")).toBeInTheDocument();
  });

  it("deletes a connection after confirmation", async () => {
    const user = userEvent.setup();
    setConnections([jiraConnection]);
    mocks.deleteMutateAsync.mockResolvedValue({ deleted: true });
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Delete Acme Jira" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(DELETE_ACME_JIRA_RE)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(mocks.deleteMutateAsync).toHaveBeenCalledWith(JIRA_CONNECTION_ID);
  });

  it("opens the inbound setup with the URL, the secret behind a reveal, and instructions", async () => {
    const user = userEvent.setup();
    setConnections([jiraConnection]);
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Inbound setup" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Inbound URL")).toHaveValue(
      "https://api.acme.dev/webhooks/integrations/key-1"
    );
    expect(within(dialog).getByLabelText("Secret")).toHaveAttribute(
      "type",
      "password"
    );
    expect(
      within(dialog).getByText("Create a webhook in Jira.")
    ).toBeInTheDocument();
  });
});

describe("IntegrationConnectionsPanel create and edit", () => {
  it("creates a connection from the provider's settings written as YAML", async () => {
    const user = userEvent.setup();
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(
      screen.getAllByRole("button", { name: "Add connection" })[0]
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: JIRA_RE }));

    await editYaml(dialog, (text) =>
      text
        .replace('siteUrl: ""', "siteUrl: https://acme.atlassian.net")
        .replace('email: ""', "email: bot@acme.dev")
    );
    await user.type(within(dialog).getByLabelText(API_TOKEN_RE), "tok-123");
    await user.click(
      within(dialog).getByRole("button", { name: "Create connection" })
    );

    expect(mocks.createMutate).toHaveBeenCalledWith(
      {
        provider: IntegrationProviderKey.Jira,
        name: "Jira",
        config: {
          deployment: DEPLOYMENT_CLOUD,
          siteUrl: "https://acme.atlassian.net",
          email: "bot@acme.dev",
        },
        secrets: { apiToken: "tok-123" },
        deliveryMode: IntegrationDeliveryMode.Webhook,
        pollIntervalSeconds: 120,
      },
      expect.any(Object)
    );
  });

  it("blocks the save and shows required errors client-side", async () => {
    const user = userEvent.setup();
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(
      screen.getAllByRole("button", { name: "Add connection" })[0]
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: JIRA_RE }));
    await editYaml(dialog, (text) => text.replace("name: Jira", "name: ''"));
    await user.click(
      within(dialog).getByRole("button", { name: "Create connection" })
    );

    expect(mocks.createMutate).not.toHaveBeenCalled();
    const problems = within(dialog).getByTestId("connection-yaml-problems");
    expect(problems).toHaveTextContent("Name the connection");
    // Site URL and bot email in the YAML, the API token in its field.
    expect(
      within(problems).getAllByText(new RegExp(REQUIRED_FIELD_MESSAGE)).length
    ).toBe(2);
    expect(
      within(dialog).getByText(REQUIRED_FIELD_MESSAGE)
    ).toBeInTheDocument();
  });

  it("checks the inbound mode against the provider and the poll interval range", async () => {
    const user = userEvent.setup();
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(
      screen.getAllByRole("button", { name: "Add connection" })[0]
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: TEAMS_RE }));
    // Teams has no inbound side: its YAML has no inbound mapping.
    const teamsText = (
      (await within(dialog).findByRole("textbox", {
        name: "Connection YAML",
      })) as HTMLTextAreaElement
    ).value;
    expect(teamsText).not.toContain("inbound:");
    await editYaml(dialog, (text) => `${text}inbound:\n  mode: poll\n`);
    await user.click(
      within(dialog).getByRole("button", { name: "Create connection" })
    );
    expect(
      within(dialog).getByTestId("connection-yaml-problems")
    ).toHaveTextContent(
      "Microsoft Teams does not receive events by poll. Modes: none"
    );

    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    await user.click(within(dialog).getByRole("button", { name: JIRA_RE }));
    await editYaml(dialog, (text) =>
      text
        .replace("mode: webhook", "mode: poll")
        .replace("pollIntervalSeconds: 120", "pollIntervalSeconds: 5")
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create connection" })
    );
    expect(
      within(dialog).getByTestId("connection-yaml-problems")
    ).toHaveTextContent(POLL_INTERVAL_RE);
  });

  it("does not resend the status when enabled is untouched", async () => {
    const user = userEvent.setup();
    setConnections([
      makeConnection({ status: IntegrationConnectionStatus.Error }),
    ]);
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Edit Acme Jira" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" })
    );

    await waitFor(() => expect(mocks.updateMutate).toHaveBeenCalled());
    const [variables] = mocks.updateMutate.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(variables.input).not.toHaveProperty("status");
  });

  it("edits a connection without resending the stored secret", async () => {
    const user = userEvent.setup();
    setConnections([jiraConnection]);
    render(<IntegrationConnectionsPanel isAdmin />);

    await user.click(screen.getByRole("button", { name: "Edit Acme Jira" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("•••• x9Kd - leave empty to keep")
    ).toBeInTheDocument();
    await editYaml(dialog, (text) =>
      text
        .replace("name: Acme Jira", "name: Jira prod")
        .replace("enabled: true", "enabled: false")
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" })
    );

    await waitFor(() => expect(mocks.updateMutate).toHaveBeenCalled());
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      {
        id: JIRA_CONNECTION_ID,
        input: {
          name: "Jira prod",
          config: {
            deployment: DEPLOYMENT_CLOUD,
            siteUrl: "https://acme.atlassian.net",
            email: "bot@acme.dev",
          },
          secrets: {},
          deliveryMode: IntegrationDeliveryMode.Webhook,
          pollIntervalSeconds: 120,
          status: IntegrationConnectionStatus.Disabled,
        },
      },
      expect.any(Object)
    );
  });
});
