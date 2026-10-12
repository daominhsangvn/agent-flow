import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
  WORKFLOW_DEFAULT_TITLE_TEMPLATE,
  WORKFLOW_POST_ACTION_EVENTS,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  JIRA_ISSUE_ASSIGNED,
  JIRA_TRANSITION_ISSUE,
  TEAMS_CONNECTION_ID,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import { REQUIRED_FIELD_MESSAGE } from "../../../integrations/lib/integration-field-values";
import {
  COMPUTE_TARGET_ID,
  makeWorkflow,
  PROJECT_ID,
  RUN_AS_USER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { WORKFLOW_FORM_MESSAGES } from "../../lib/workflow-form";
import {
  WORKFLOW_RUN_EVENT_LABELS,
  WORKFLOW_SOURCE_SYSTEMS_NOTICE,
  WorkflowMutationErrorTitle,
} from "../../lib/workflow-labels";
import { WorkflowEditor } from "../workflow-editor";
import {
  actionRow,
  COMPUTE_TARGETS,
  CONTINUE_ON_ERROR_RE,
  choose,
  DISABLED_CONNECTION_MESSAGE,
  editorMocks,
  fillRequiredBasics,
  HTTP_ENDPOINT_AFTER_SAVE_RE,
  lastCreateInput,
  type MutateOptions,
  PLAN_ONLY_RE,
  POST_ACTIONS_HELP_RE,
  PRE_ACTIONS_HELP,
  REQUIRED_LABEL_RE,
  resetEditorMocks,
  STOP_WHEN_THE_PLAN_HAS_RE,
  section,
  TRANSITION_LABEL_RE,
  USE_A_SPECIFIC_REPOSITORY_RE,
} from "./workflow-editor.test-helpers";

// The editor's modules read the shared harness state (workflow-editor.test-helpers).
// CodeMirror needs a layout engine: the process YAML view gets a textarea.
vi.mock(
  "@repo/app/projects/components/process-yaml-editor",
  async () =>
    (
      await import(
        "@repo/app/projects/components/__tests__/process-yaml-editor.test-helpers"
      )
    ).processYamlEditorModule
);
vi.mock("@repo/app/projects/hooks/use-project-process", async () =>
  (
    await import("./workflow-editor.test-helpers")
  ).editorModuleMocks.projectProcess()
);
vi.mock("@repo/app/projects/hooks/use-project-repositories", async () =>
  (
    await import("./workflow-editor.test-helpers")
  ).editorModuleMocks.projectRepositories()
);
vi.mock("@repo/app/integrations/hooks/use-integrations", async () =>
  (
    await import("./workflow-editor.test-helpers")
  ).editorModuleMocks.integrations()
);
vi.mock("@repo/app/projects/hooks/use-projects", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.projects()
);
vi.mock("@repo/app/users/hooks/use-users", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.users()
);
vi.mock("../../hooks/use-workflows", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.workflows()
);
vi.mock("@repo/navigation/use-navigation", async () =>
  (
    await import("./workflow-editor.test-helpers")
  ).editorModuleMocks.navigation()
);
vi.mock("@repo/navigation/use-org-path", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.orgPath()
);
vi.mock("@repo/navigation/link", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.link()
);
vi.mock("@repo/design-system/components/ui/sonner", async () =>
  (await import("./workflow-editor.test-helpers")).editorModuleMocks.sonner()
);

beforeEach(() => {
  resetEditorMocks();
});

describe("WorkflowEditor (create)", () => {
  it("starts a workflow from its own HTTP endpoint without a connection", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    const triggers = section("Triggers");
    await choose(
      user,
      within(triggers).getByRole("combobox", { name: "Source" }),
      "HTTP request (this workflow's URL)"
    );
    // The webhook provider has one trigger, preselected.
    expect(
      within(triggers).getByRole("combobox", { name: "Trigger" })
    ).toHaveTextContent("HTTPS request");
    expect(
      within(triggers).getByText(HTTP_ENDPOINT_AFTER_SAVE_RE)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(editorMocks.createMutate).toHaveBeenCalledTimes(1)
    );
    expect(lastCreateInput().triggers).toEqual([
      {
        connectionId: null,
        type: WEBHOOK_REQUEST,
        config: {},
        enabled: true,
      },
    ]);
  });

  it("creates a workflow whose payload matches SaveWorkflowInput", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    // The Jira provider has exactly one trigger, so it is preselected.
    expect(
      within(section("Triggers")).getByRole("combobox", { name: "Trigger" })
    ).toHaveTextContent("Issue assigned to the bot");

    const actions = section("Post actions");
    await user.click(
      within(actions).getByRole("button", { name: "Add post action" })
    );
    await choose(
      user,
      within(actions).getByRole("combobox", { name: "Connection" }),
      "Delivery channel"
    );
    // Teams offers one action, preselected with its default events.
    expect(
      within(actions).getByRole("checkbox", { name: "Run succeeded" })
    ).toBeChecked();
    await user.click(
      within(actions).getByRole("checkbox", { name: "Run failed" })
    );

    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(editorMocks.createMutate).toHaveBeenCalledTimes(1)
    );
    const input = lastCreateInput();
    expect(saveWorkflowInputSchema.parse(input)).toEqual(input);
    expect(input).toEqual({
      name: "Jira to PR",
      description: "",
      enabled: true,
      projectId: PROJECT_ID,
      agent: {
        mode: WorkflowAgentMode.PlanAndExecute,
        stopOnOpenQuestions: true,
        computeTargetId: COMPUTE_TARGET_ID,
        repository: null,
        instructions: "",
        titleTemplate: WORKFLOW_DEFAULT_TITLE_TEMPLATE,
        process: null,
      },
      triggers: [
        {
          connectionId: JIRA_CONNECTION_ID,
          type: JIRA_ISSUE_ASSIGNED,
          config: { projectKeys: [], label: "ai" },
          enabled: true,
        },
      ],
      actions: [
        {
          connectionId: TEAMS_CONNECTION_ID,
          type: TEAMS_POST_MESSAGE,
          config: { message: "{{summary}}" },
          stage: WorkflowActionStage.Post,
          events: [WorkflowRunEvent.Succeeded, WorkflowRunEvent.Failed],
          continueOnError: false,
          enabled: true,
        },
      ],
    });
  }, 15_000);

  it("lays out the flow: triggers, pre actions, agent team, post actions", () => {
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent)
    ).toEqual([
      "Basics",
      "Triggers",
      "Pre actions",
      "Agent team",
      "Post actions",
    ]);
    expect(
      screen.getByText(WORKFLOW_SOURCE_SYSTEMS_NOTICE)
    ).toBeInTheDocument();
    expect(
      within(section("Pre actions")).getByText(PRE_ACTIONS_HELP)
    ).toBeInTheDocument();
    expect(
      within(section("Post actions")).getByText(POST_ACTIONS_HELP_RE)
    ).toBeInTheDocument();
  });

  it("adds, configures and reorders pre actions and sends them first, in order", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    const preActions = section("Pre actions");
    await user.click(
      within(preActions).getByRole("button", { name: "Add pre action" })
    );
    const first = actionRow("Pre action 1");
    await choose(
      user,
      within(first).getByRole("combobox", { name: "Connection" }),
      "Acme Jira"
    );
    await choose(
      user,
      within(first).getByRole("combobox", { name: "Action" }),
      "Transition the issue"
    );
    await user.type(
      within(first).getByLabelText(TRANSITION_LABEL_RE),
      "In Progress"
    );
    const continueSwitch = within(first).getByRole("switch", {
      name: CONTINUE_ON_ERROR_RE,
    });
    expect(continueSwitch).not.toBeChecked();
    await user.click(continueSwitch);
    // Pre actions always run on the trigger: no event selector.
    expect(within(first).queryAllByRole("checkbox")).toHaveLength(0);

    await user.click(
      within(preActions).getByRole("button", { name: "Add pre action" })
    );
    await choose(
      user,
      within(actionRow("Pre action 2")).getByRole("combobox", {
        name: "Connection",
      }),
      "Delivery channel"
    );
    // Teams offers one action, preselected.
    expect(
      within(actionRow("Pre action 2")).getByRole("combobox", {
        name: "Action",
      })
    ).toHaveTextContent("Post a message");

    expect(
      within(preActions).getByRole("button", { name: "Move pre action 1 up" })
    ).toBeDisabled();
    expect(
      within(preActions).getByRole("button", {
        name: "Move pre action 2 down",
      })
    ).toBeDisabled();
    await user.click(
      within(preActions).getByRole("button", { name: "Move pre action 2 up" })
    );

    // The Teams action is now first; the Jira transition keeps its settings.
    expect(
      within(actionRow("Pre action 1")).getByRole("combobox", {
        name: "Action",
      })
    ).toHaveTextContent("Post a message");
    expect(
      within(actionRow("Pre action 2")).getByLabelText(TRANSITION_LABEL_RE)
    ).toHaveValue("In Progress");
    expect(
      within(actionRow("Pre action 2")).getByRole("switch", {
        name: CONTINUE_ON_ERROR_RE,
      })
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(editorMocks.createMutate).toHaveBeenCalledTimes(1)
    );
    const input = lastCreateInput();
    expect(saveWorkflowInputSchema.parse(input)).toEqual(input);
    expect(input.actions).toEqual([
      {
        connectionId: TEAMS_CONNECTION_ID,
        type: TEAMS_POST_MESSAGE,
        config: { message: "{{summary}}" },
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: false,
        enabled: true,
      },
      {
        connectionId: JIRA_CONNECTION_ID,
        type: JIRA_TRANSITION_ISSUE,
        config: { transition: "In Progress" },
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: true,
        enabled: true,
      },
    ]);
  }, 15_000);

  it("validates pre action configs and removes a pre action", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    const preActions = section("Pre actions");
    await user.click(
      within(preActions).getByRole("button", { name: "Add pre action" })
    );
    const row = actionRow("Pre action 1");
    await choose(
      user,
      within(row).getByRole("combobox", { name: "Connection" }),
      "Acme Jira"
    );
    await choose(
      user,
      within(row).getByRole("combobox", { name: "Action" }),
      "Transition the issue"
    );
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(
      await within(row).findByText(REQUIRED_FIELD_MESSAGE)
    ).toBeInTheDocument();
    expect(editorMocks.createMutate).not.toHaveBeenCalled();

    await user.click(
      within(preActions).getByRole("button", { name: "Remove pre action 1" })
    );
    expect(
      within(preActions).queryByRole("heading", { name: "Pre action 1" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create workflow" }));
    await waitFor(() =>
      expect(editorMocks.createMutate).toHaveBeenCalledTimes(1)
    );
    expect(lastCreateInput().actions).toEqual([]);
  }, 15_000);

  it("offers post actions every run event except the trigger", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    const postActions = section("Post actions");
    await user.click(
      within(postActions).getByRole("button", { name: "Add post action" })
    );
    await choose(
      user,
      within(postActions).getByRole("combobox", { name: "Connection" }),
      "Acme Jira"
    );
    // This action's defaults include run.triggered, which is not preselected.
    await choose(
      user,
      within(postActions).getByRole("combobox", { name: "Action" }),
      "Transition the issue"
    );

    const checkboxes = within(postActions).getAllByRole("checkbox");
    expect(checkboxes.map((checkbox) => checkbox.id)).toEqual(
      WORKFLOW_POST_ACTION_EVENTS.map(
        (event) => `workflow-post-action-0-event-${event}`
      )
    );
    expect(
      within(postActions).queryByRole("checkbox", {
        name: WORKFLOW_RUN_EVENT_LABELS[WorkflowRunEvent.Triggered],
      })
    ).not.toBeInTheDocument();
    expect(
      within(postActions)
        .getAllByRole("checkbox", { checked: true })
        .map((checkbox) => checkbox.id)
    ).toEqual([`workflow-post-action-0-event-${WorkflowRunEvent.Succeeded}`]);
  });

  it("shows the server's message in the footer when a create is rejected", () => {
    editorMocks.createError = new ApiError(DISABLED_CONNECTION_MESSAGE, 400);
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(WorkflowMutationErrorTitle.Create);
    expect(alert).toHaveTextContent(DISABLED_CONNECTION_MESSAGE);
  });

  it("navigates to the new workflow after a create", async () => {
    const user = userEvent.setup();
    editorMocks.createMutate.mockImplementation(
      (_input: SaveWorkflowInput, options: MutateOptions) =>
        options.onSuccess?.(makeWorkflow())
    );
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(editorMocks.navigate).toHaveBeenCalledWith(
        `/acme/workflows/${WORKFLOW_ID}`
      )
    );
    expect(editorMocks.toastSuccess).toHaveBeenCalledWith("Workflow created");
  });

  it("blocks the save with field errors when required fields are missing", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(
      await screen.findByText(WORKFLOW_FORM_MESSAGES.nameRequired)
    ).toBeInTheDocument();
    expect(
      screen.getByText(WORKFLOW_FORM_MESSAGES.projectRequired)
    ).toBeInTheDocument();
    expect(
      screen.getByText(WORKFLOW_FORM_MESSAGES.computeTargetRequired)
    ).toBeInTheDocument();
    expect(
      screen.getByText(WORKFLOW_FORM_MESSAGES.connectionRequired)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Some fields need attention before the workflow can be saved."
      )
    ).toBeInTheDocument();
    expect(editorMocks.createMutate).not.toHaveBeenCalled();
  });

  it("validates trigger configs against their descriptors", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    const triggers = section("Triggers");
    await user.clear(within(triggers).getByLabelText(REQUIRED_LABEL_RE));
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(
      await within(triggers).findByText(REQUIRED_FIELD_MESSAGE)
    ).toBeInTheDocument();
    expect(editorMocks.createMutate).not.toHaveBeenCalled();

    // Fixing the field clears the message right away.
    await user.type(within(triggers).getByLabelText(REQUIRED_LABEL_RE), "ai");
    expect(within(triggers).queryByText(REQUIRED_FIELD_MESSAGE)).toBeNull();
  });

  it("adds and removes triggers", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    const triggers = section("Triggers");
    await user.click(
      within(triggers).getByRole("button", { name: "Add trigger" })
    );
    expect(within(triggers).getByText("Trigger 2")).toBeInTheDocument();
    await user.click(
      within(triggers).getByRole("button", { name: "Remove trigger 1" })
    );
    await user.click(
      within(triggers).getByRole("button", { name: "Remove trigger 1" })
    );
    await user.click(screen.getByRole("button", { name: "Create workflow" }));
    expect(
      await screen.findByText(WORKFLOW_FORM_MESSAGES.triggersRequired)
    ).toBeInTheDocument();
  });

  it("hides the open-questions switch in plan-only mode and sends the mode", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    expect(
      screen.getByRole("switch", {
        name: STOP_WHEN_THE_PLAN_HAS_RE,
      })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: PLAN_ONLY_RE }));
    expect(
      screen.queryByRole("switch", {
        name: STOP_WHEN_THE_PLAN_HAS_RE,
      })
    ).not.toBeInTheDocument();

    await fillRequiredBasics(user);
    await user.click(screen.getByRole("button", { name: "Create workflow" }));
    await waitFor(() => expect(editorMocks.createMutate).toHaveBeenCalled());
    expect(lastCreateInput().agent.mode).toBe(WorkflowAgentMode.Plan);
  });

  it("sends a repository override and a run-as user", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);

    await fillRequiredBasics(user);
    const agent = section("Agent team");
    await choose(
      user,
      within(agent).getByRole("combobox", { name: "Run as" }),
      "Ada Admin"
    );
    await user.click(
      within(agent).getByRole("switch", { name: USE_A_SPECIFIC_REPOSITORY_RE })
    );
    await user.type(within(agent).getByLabelText("Repository"), "acme/web");
    await user.type(within(agent).getByLabelText("Base branch"), "main");
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() => expect(editorMocks.createMutate).toHaveBeenCalled());
    expect(lastCreateInput().runAsUserId).toBe(RUN_AS_USER_ID);
    expect(lastCreateInput().agent.repository).toEqual({
      fullName: "acme/web",
      branch: "main",
    });
  });
});
