import type {
  IntegrationConnection,
  IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  type SaveWorkflowInput,
  type Workflow,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  jiraConnection,
  makeProjectConnections,
  PROVIDERS,
  teamsConnection,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  ACTION_ID,
  COMPUTE_TARGET_ID,
  makeSaveWorkflowInput,
  makeWorkflow,
  PRE_ACTION_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
  TRIGGER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import type { WorkflowComputeTargetChoices } from "../../lib/workflow-editor-options";
import { WorkflowEditor } from "../workflow-editor";

type MutateOptions = { onSuccess?: (workflow: Workflow) => void };

const mocks = vi.hoisted(() => ({
  providers: {
    data: undefined as IntegrationProviderSummary[] | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  connections: {
    data: undefined as IntegrationConnection[] | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  projectsError: null as Error | null,
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  repositoriesEnabled: [] as boolean[],
}));

vi.mock(
  "../workflow-yaml-editor",
  async () =>
    (await import("./workflow-yaml-editor.test-helpers"))
      .workflowYamlEditorModule
);

vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ ...mocks.providers, refetch: vi.fn() }),
  useIntegrationConnections: () => ({ ...mocks.connections, refetch: vi.fn() }),
}));

vi.mock("@repo/app/projects/hooks/use-project-connections", () => ({
  useOrgProjectConnections: () => ({
    data: makeProjectConnections(PROJECT_ID),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({
    data: mocks.projectsError ? undefined : [{ id: PROJECT_ID, name: "Web" }],
    isLoading: false,
    error: mocks.projectsError,
  }),
}));

vi.mock("@repo/app/projects/hooks/use-project-repositories", () => ({
  useProjectRepositories: (
    _projectId: string,
    options: { enabled?: boolean } = {}
  ) => {
    mocks.repositoriesEnabled.push(options.enabled ?? true);
    return { data: [{ fullName: "acme/web" }], isLoading: false, error: null };
  },
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({
    data: [
      {
        id: RUN_AS_USER_ID,
        firstName: "Ada",
        lastName: "Admin",
        email: "ada@acme.dev",
        active: true,
      },
    ],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../../hooks/use-workflows", () => ({
  useCreateWorkflow: () => ({
    mutate: mocks.createMutate,
    isPending: false,
    error: null,
  }),
  useUpdateWorkflow: () => ({
    mutate: mocks.updateMutate,
    isPending: false,
    error: null,
  }),
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

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

const RUNNERS: WorkflowComputeTargetChoices = {
  options: [{ id: COMPUTE_TARGET_ID, label: "runner-1", isOnline: true }],
  isLoading: false,
  error: null,
};
const HTTP_CONNECTION_ID = "12121212-1212-4121-8121-121212121212";
const NEW_WORKFLOW_ID = "13131313-1313-4131-8131-131313131313";
const FIX_PROBLEMS_RE = /Fix the problems above/;
const SAVE_RE = /Save workflow/;
const CREATE_RE = /Create workflow/;
const DISCARD_RE = /Discard changes/;
const READ_ONLY_RE = /Only organization admins can change workflows/;
const OWN_URL_AFTER_SAVE_RE = /gets its own URL and signing secret/;
const PREVIEW_AFTER_FIX_RE = /show here once the YAML has no errors/;

function yamlBox(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Workflow YAML" });
}

function setYaml(text: string) {
  fireEvent.change(yamlBox(), { target: { value: text } });
}

/** Renders the editor and waits for the (lazily loaded) YAML editor. */
async function renderEditor(
  props: Partial<Parameters<typeof WorkflowEditor>[0]> = {}
) {
  const view = render(
    <WorkflowEditor
      computeTargets={RUNNERS}
      connectionsSettingsPath="/settings?tab=integrations"
      isAdmin
      {...props}
    />
  );
  await screen.findByRole("textbox", { name: "Workflow YAML" });
  return view;
}

function lastCreateInput(): SaveWorkflowInput {
  return mocks.createMutate.mock.calls.at(-1)?.[0] as SaveWorkflowInput;
}

function lastUpdate(): { id: string; input: SaveWorkflowInput } {
  return mocks.updateMutate.mock.calls.at(-1)?.[0] as {
    id: string;
    input: SaveWorkflowInput;
  };
}

describe("WorkflowEditor (YAML)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers = { data: PROVIDERS, isLoading: false, error: null };
    mocks.connections = {
      data: [jiraConnection, teamsConnection],
      isLoading: false,
      error: null,
    };
    mocks.projectsError = null;
    mocks.repositoriesEnabled = [];
  });

  it("starts a new workflow from YAML with its own HTTP endpoint and creates it", async () => {
    const user = userEvent.setup();
    await renderEditor();

    expect(yamlBox().value).toContain("name: New workflow");
    expect(yamlBox().value).toContain("  - connection: http");
    expect(screen.getByText(OWN_URL_AFTER_SAVE_RE)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: CREATE_RE }));

    expect(lastCreateInput()).toMatchObject({
      name: "New workflow",
      projectId: PROJECT_ID,
      agent: {
        computeTargetId: COMPUTE_TARGET_ID,
        mode: WorkflowAgentMode.PlanAndExecute,
      },
      triggers: [{ connectionKey: null, type: WEBHOOK_REQUEST }],
    });
    const [, options] = mocks.createMutate.mock.calls.at(-1) as [
      SaveWorkflowInput,
      MutateOptions,
    ];
    act(() => {
      options.onSuccess?.(makeWorkflow({ id: NEW_WORKFLOW_ID }));
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
      `/acme/workflows/${NEW_WORKFLOW_ID}`
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Workflow created");
  });

  it("does not save YAML with problems and lists them by line", async () => {
    const user = userEvent.setup();
    await renderEditor();
    setYaml(yamlBox().value.replace("\nproject: Web", "\nproject: Mobile"));

    await user.click(screen.getByRole("button", { name: CREATE_RE }));

    expect(mocks.createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(FIX_PROBLEMS_RE);
    expect(screen.getByTestId("workflow-yaml-problems")).toHaveTextContent(
      'No project "Mobile". Available: Web'
    );
  });

  it("opens the configuration guide on a new workflow", async () => {
    await renderEditor();

    expect(
      screen.getByRole("button", { name: "Configuration guide" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("explains the configuration above the YAML and lists the actions in run order below it", async () => {
    const user = userEvent.setup();
    await renderEditor({ workflow: makeWorkflow() });

    const guide = screen.getByRole("button", { name: "Configuration guide" });
    expect(guide).toHaveAttribute("aria-expanded", "false");
    await user.click(guide);
    expect(
      screen.getByRole("tab", { name: "Connections" })
    ).toBeInTheDocument();

    const preview = screen.getByRole("region", {
      name: "Actions in run order",
    });
    expect(
      within(preview).getByText(WorkflowRunEvent.Triggered)
    ).toBeInTheDocument();
    expect(within(preview).getAllByText("On delivery.")).toHaveLength(2);

    setYaml(yamlBox().value.replace("\nproject: Web", "\nproject: Mobile"));

    expect(
      screen.queryByRole("region", { name: "Actions in run order" })
    ).toBeNull();
    expect(screen.getByText(PREVIEW_AFTER_FIX_RE)).toBeInTheDocument();
  });

  it("edits a saved workflow by name and keeps its trigger and action ids", async () => {
    const user = userEvent.setup();
    const workflow = makeWorkflow();
    await renderEditor({ workflow });

    expect(yamlBox().value).toContain("  - connection: acme-jira");
    expect(yamlBox().value).toContain("  runner: runner-1");
    setYaml(
      yamlBox().value.replace(
        `  mode: ${WorkflowAgentMode.PlanAndExecute}`,
        `  mode: ${WorkflowAgentMode.Plan}`
      )
    );

    await user.click(screen.getByRole("button", { name: SAVE_RE }));

    const { id, input } = lastUpdate();
    expect(id).toBe(WORKFLOW_ID);
    expect(input).toEqual({
      ...makeSaveWorkflowInput(),
      agent: {
        ...makeSaveWorkflowInput().agent,
        mode: WorkflowAgentMode.Plan,
      },
    });
    expect(input.triggers[0]?.id).toBe(TRIGGER_ID);
    expect(input.actions.map((action) => action.id)).toEqual([
      PRE_ACTION_ID,
      ACTION_ID,
    ]);
  });

  it("discards unsaved changes back to the stored workflow", async () => {
    const user = userEvent.setup();
    await renderEditor({ workflow: makeWorkflow() });
    const stored = yamlBox().value;
    const discard = screen.getByRole("button", { name: DISCARD_RE });
    expect(discard).toBeDisabled();

    setYaml(`${stored}# a note\n`);
    await user.click(discard);

    expect(yamlBox().value).toBe(stored);
  });

  it("keeps the edited text as the saved one after a save", async () => {
    const user = userEvent.setup();
    await renderEditor({ workflow: makeWorkflow() });
    const edited = yamlBox().value.replace(
      "name: Implement Jira requirements",
      "name: Jira intake"
    );
    setYaml(edited);

    await user.click(screen.getByRole("button", { name: SAVE_RE }));
    const [, options] = mocks.updateMutate.mock.calls.at(-1) as [
      unknown,
      MutateOptions,
    ];
    act(() => {
      options.onSuccess?.(makeWorkflow({ name: "Jira intake" }));
    });

    expect(mocks.toastSuccess).toHaveBeenCalledWith("Workflow saved");
    expect(yamlBox().value).toBe(edited);
    expect(screen.getByRole("button", { name: DISCARD_RE })).toBeDisabled();
  });

  it("shows members the YAML read-only, without a save", async () => {
    await renderEditor({ workflow: makeWorkflow(), isAdmin: false });

    expect(screen.getByText(READ_ONLY_RE)).toBeInTheDocument();
    expect(yamlBox()).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: SAVE_RE })).toBeNull();
  });

  it("shows the URL and secret of a saved workflow's own HTTP endpoint", async () => {
    const httpConnection = {
      ...jiraConnection,
      id: HTTP_CONNECTION_ID,
      name: "Workflow endpoint",
      managedByWorkflowId: WORKFLOW_ID,
    };
    mocks.connections = {
      data: [jiraConnection, teamsConnection, httpConnection],
      isLoading: false,
      error: null,
    };
    const workflow = makeWorkflow({
      httpEndpointConnectionId: HTTP_CONNECTION_ID,
      triggers: [
        {
          id: TRIGGER_ID,
          projectId: PROJECT_ID,
          connectionKey: null,
          projectConnectionId: null,
          connectionId: HTTP_CONNECTION_ID,
          builtInHttp: true,
          type: WEBHOOK_REQUEST,
          config: {},
          enabled: true,
          position: 0,
        },
      ],
    });

    await renderEditor({ workflow });

    expect(yamlBox().value).toContain("  - connection: http");
    expect(
      screen.getByRole("button", { name: "Show URL and secret" })
    ).toBeInTheDocument();
  });

  it("loads the project's repositories only once the YAML names a repository", async () => {
    await renderEditor({ workflow: makeWorkflow() });
    expect(mocks.repositoriesEnabled.at(-1)).toBe(false);

    setYaml(
      yamlBox().value.replace(
        "  stopOnOpenQuestions: true",
        "  stopOnOpenQuestions: true\n  repository:\n    fullName: acme/web\n    branch: main"
      )
    );

    expect(mocks.repositoriesEnabled.at(-1)).toBe(true);
  });

  it("waits for the integrations, then reports when they fail to load", () => {
    mocks.providers = { data: undefined, isLoading: true, error: null };
    const { rerender } = render(
      <WorkflowEditor computeTargets={RUNNERS} isAdmin />
    );
    expect(
      screen.getByRole("status", { name: "Loading workflow editor" })
    ).toBeInTheDocument();

    mocks.providers = { data: PROVIDERS, isLoading: false, error: null };
    mocks.connections = {
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    };
    rerender(<WorkflowEditor computeTargets={RUNNERS} isAdmin />);

    expect(screen.getByText("Couldn't load integrations")).toBeInTheDocument();
  });

  it("still edits by id when the projects cannot be loaded", async () => {
    mocks.projectsError = new Error("projects down");
    await renderEditor({ workflow: makeWorkflow() });

    expect(
      screen.getByText(
        "Couldn't load the projects: they are not suggested, and the YAML can only name them by id."
      )
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(yamlBox().value).toContain(`\nproject: ${PROJECT_ID}`)
    );
  });
});
