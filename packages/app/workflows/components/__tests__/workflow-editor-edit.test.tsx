import { LoopStepFinish } from "@agentflow-ai/loops-api/loop-step";
import {
  ProcessQuestionsPolicy,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import {
  type SaveWorkflowInput,
  saveWorkflowInputSchema,
  WorkflowActionStage,
} from "@repo/api/src/types/workflow";
import { ProcessFormEnabled } from "@repo/app/projects/components/__tests__/process-form-flag.test-helpers";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_ID,
  makeWorkflow,
  PRE_ACTION_ID,
  RUN_AS_USER_ID,
  TRIGGER_ID,
  WORKFLOW_ID,
} from "../../__tests__/workflow-fixtures";
import { WorkflowMutationErrorTitle } from "../../lib/workflow-labels";
import { WorkflowEditor } from "../workflow-editor";
import {
  actionRow,
  COMPUTE_TARGETS,
  CONTINUE_ON_ERROR_RE,
  DISABLED_CONNECTION_MESSAGE,
  editorMocks,
  fillRequiredBasics,
  lastCreateInput,
  lastUpdateInput,
  type MutateOptions,
  ONLY_ORGANIZATION_ADMINS_CAN_CHANGE_RE,
  OWN_PROCESS_PROJECT_DESCRIPTION_RE,
  PLAN_ONLY_RE,
  RUN_AS_SAVER_OPTION,
  resetEditorMocks,
  STOP_WHEN_THE_PLAN_HAS_RE,
  section,
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

describe("WorkflowEditor: a workflow's own process", () => {
  it("starts from the project's process, saves it with the workflow and hides the mode settings", async () => {
    const user = userEvent.setup();
    editorMocks.projectProcess = {
      current: {
        version: 2,
        definition: {
          toolkit: null,
          steps: [
            {
              type: ProcessStepType.Agent,
              id: "analyze",
              name: "Analyze",
              instruction: "/ba-analyze {{issue.file}}",
              questions: ProcessQuestionsPolicy.Ask,
              artifacts: [],
              reply: null,
              document: null,
              finish: LoopStepFinish.None,
              timeoutMinutes: null,
            },
          ],
        },
        createdAt: "2026-10-01T09:00:00.000Z",
        createdBy: null,
      },
      invalidVersion: null,
    };
    // The process's form view is behind its flag.
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />, {
      wrapper: ProcessFormEnabled,
    });
    await fillRequiredBasics(user);

    const processBox = screen.getByTestId("workflow-process");
    expect(
      within(processBox).getByText(OWN_PROCESS_PROJECT_DESCRIPTION_RE)
    ).toBeVisible();
    await user.click(
      within(processBox).getByRole("radio", { name: "Its own process" })
    );

    await user.click(within(processBox).getByRole("tab", { name: "Form" }));
    expect(within(processBox).getByLabelText("Step id")).toHaveValue("analyze");
    expect(
      screen.queryByTestId("workflow-project-process-notice")
    ).not.toBeInTheDocument();
    const reply = within(processBox).getByLabelText("Reply file");
    await user.type(reply, ".agentflow-ai/work/answer.md");
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() => expect(editorMocks.createMutate).toHaveBeenCalled());
    expect(lastCreateInput().agent.process).toMatchObject({
      toolkit: null,
      steps: [
        {
          id: "analyze",
          instruction: "/ba-analyze {{issue.file}}",
          reply: ".agentflow-ai/work/answer.md",
        },
      ],
    });
  });

  it("goes back to the project's process", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditor computeTargets={COMPUTE_TARGETS} isAdmin />);
    await fillRequiredBasics(user);

    const processBox = screen.getByTestId("workflow-process");
    await user.click(
      within(processBox).getByRole("radio", { name: "Its own process" })
    );
    expect(
      screen.queryByRole("radio", { name: PLAN_ONLY_RE })
    ).not.toBeInTheDocument();
    await user.click(
      within(processBox).getByRole("radio", { name: "The project's process" })
    );
    expect(screen.getByRole("radio", { name: PLAN_ONLY_RE })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() => expect(editorMocks.createMutate).toHaveBeenCalled());
    expect(lastCreateInput().agent.process).toBeNull();
  });
});

describe("WorkflowEditor (edit)", () => {
  it("defers to the project's own process instead of the mode settings", () => {
    editorMocks.projectProcess = {
      current: {
        version: 3,
        definition: {
          toolkit: null,
          steps: [
            {
              type: ProcessStepType.Agent,
              id: "specify",
              name: "Specify",
              instruction: "/specify",
              questions: ProcessQuestionsPolicy.Continue,
              artifacts: [],
              reply: null,
              document: null,
              finish: LoopStepFinish.None,
              timeoutMinutes: null,
            },
            {
              type: ProcessStepType.Approval,
              id: "review",
              name: "Review",
              show: [],
            },
          ],
        },
        createdAt: "2026-10-01T09:00:00.000Z",
        createdBy: null,
      },
      invalidVersion: null,
    };
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow()}
      />
    );

    expect(
      screen.getByTestId("workflow-project-process-notice")
    ).toHaveTextContent("version 3, Specify → Review");
    expect(
      screen.queryByRole("radio", { name: PLAN_ONLY_RE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: STOP_WHEN_THE_PLAN_HAS_RE })
    ).not.toBeInTheDocument();
  });

  it("saves an existing workflow with PUT semantics and keeps ids", async () => {
    const user = userEvent.setup();
    const workflow = makeWorkflow();
    editorMocks.updateMutate.mockImplementation(
      (_variables: unknown, options: MutateOptions) =>
        options.onSuccess?.(workflow)
    );
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={workflow}
      />
    );

    expect(screen.getByLabelText("Name")).toHaveValue(workflow.name);
    // The stored pre action is loaded into its own section.
    const preAction = actionRow("Pre action 1");
    expect(
      within(preAction).getByRole("combobox", { name: "Action" })
    ).toHaveTextContent("Transition the issue");
    expect(
      within(preAction).getByRole("switch", { name: CONTINUE_ON_ERROR_RE })
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save workflow" }));

    await waitFor(() => expect(editorMocks.updateMutate).toHaveBeenCalled());
    const [variables] = editorMocks.updateMutate.mock.calls[0] as [
      { id: string; input: SaveWorkflowInput },
    ];
    expect(variables.id).toBe(WORKFLOW_ID);
    expect(saveWorkflowInputSchema.parse(variables.input)).toEqual(
      variables.input
    );
    expect(variables.input.runAsUserId).toBe(RUN_AS_USER_ID);
    expect(variables.input.triggers[0]?.id).toBe(TRIGGER_ID);
    expect(
      variables.input.actions.map((action) => [
        action.id,
        action.stage,
        action.continueOnError,
      ])
    ).toEqual([
      [PRE_ACTION_ID, WorkflowActionStage.Pre, true],
      [ACTION_ID, WorkflowActionStage.Post, false],
    ]);
    expect(editorMocks.toastSuccess).toHaveBeenCalledWith("Workflow saved");
  }, 15_000);

  it("offers 'whoever saves' only when no run-as user is stored", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow()}
      />
    );
    await user.click(screen.getByRole("combobox", { name: "Run as" }));
    expect(
      await screen.findByRole("option", { name: "Ada Admin" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: RUN_AS_SAVER_OPTION })
    ).not.toBeInTheDocument();
    unmount();

    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow({ runAsUser: null })}
      />
    );
    await user.click(screen.getByRole("combobox", { name: "Run as" }));
    expect(
      await screen.findByRole("option", { name: RUN_AS_SAVER_OPTION })
    ).toBeInTheDocument();
  });

  it("shows the server's message in the footer when a save is rejected", () => {
    editorMocks.updateError = new ApiError(DISABLED_CONNECTION_MESSAGE, 400);
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow()}
      />
    );

    const saveButton = screen.getByRole("button", { name: "Save workflow" });
    const footer = saveButton.closest(".sticky");
    if (!(footer instanceof HTMLElement)) {
      throw new Error("No editor footer");
    }
    const alert = within(footer).getByRole("alert");
    expect(alert).toHaveTextContent(WorkflowMutationErrorTitle.Update);
    expect(alert).toHaveTextContent(DISABLED_CONNECTION_MESSAGE);
  });

  it("turns the workflow off right away from the enabled switch, without saving the form", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow()}
      />
    );

    const enabled = within(section("Basics")).getByRole("switch", {
      name: "Enabled",
    });
    expect(enabled).toBeChecked();
    await user.click(enabled);

    expect(editorMocks.setEnabledMutate).toHaveBeenCalledWith({
      id: WORKFLOW_ID,
      input: { enabled: false },
    });
    expect(editorMocks.updateMutate).not.toHaveBeenCalled();
  });

  it("shows why the enabled switch could not be flipped", () => {
    editorMocks.setEnabledError = new ApiError(
      "The run-as user must be an active member",
      400
    );
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={makeWorkflow({ enabled: false })}
      />
    );

    const alert = within(section("Basics")).getByRole("alert");
    expect(alert).toHaveTextContent(WorkflowMutationErrorTitle.SetEnabled);
    expect(alert).toHaveTextContent("The run-as user must be an active member");
  });

  it("re-sends the stored enabled flag on save, also after the switch changed it", async () => {
    const user = userEvent.setup();
    const workflow = makeWorkflow({ enabled: false });
    const { rerender } = render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={workflow}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() =>
      expect(editorMocks.updateMutate).toHaveBeenCalledTimes(1)
    );
    expect(lastUpdateInput().enabled).toBe(false);

    // The switch's PATCH refreshed the cached workflow; the form was not reset.
    rerender(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin
        workflow={{ ...workflow, enabled: true }}
      />
    );
    await user.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() =>
      expect(editorMocks.updateMutate).toHaveBeenCalledTimes(2)
    );
    expect(lastUpdateInput().enabled).toBe(true);
  }, 15_000);

  it("is read-only for members", () => {
    render(
      <WorkflowEditor
        computeTargets={COMPUTE_TARGETS}
        isAdmin={false}
        workflow={makeWorkflow()}
      />
    );

    expect(
      screen.getByText(ONLY_ORGANIZATION_ADMINS_CAN_CHANGE_RE)
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add trigger" })).toBeDisabled();
    // Both action sections are visible, read-only.
    expect(
      screen.getByRole("heading", { name: "Pre action 1" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Post action 1" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add pre action" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove pre action 1" })
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: CONTINUE_ON_ERROR_RE })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save workflow" })
    ).not.toBeInTheDocument();
  });
});
