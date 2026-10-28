import {
  AgentFlowStepId,
  ProcessDocumentType,
  ProcessExecuteReview,
  ProcessPlanRecommendations,
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
  type ProjectProcessState,
  type ProjectProcessVersion,
} from "@repo/api/src/types/project-process";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProcessPanel } from "../project-process-panel";
import { ProcessFormEnabled } from "./process-form-flag.test-helpers";

const PROJECT_ID = "project-1";
const SAVED_BY_RE = /Version 4 · saved by Ada Admin/;
const UNREADABLE_RE = /Version 7 cannot be read by this version/;
const ONLY_ADMINS_RE = /Only organization admins can change it/;

const mocks = vi.hoisted(() => ({
  state: undefined as ProjectProcessState | undefined,
  versions: [] as ProjectProcessVersion[],
  saveMutate: vi.fn(),
}));

// These tests edit through the Form tab (behind its flag, turned on in every
// render); project-process-yaml.test.tsx covers the YAML-only default.
// CodeMirror needs a layout engine: the YAML view gets a textarea.
vi.mock(
  "../process-yaml-editor",
  async () =>
    (await import("./process-yaml-editor.test-helpers")).processYamlEditorModule
);
vi.mock("../../hooks/use-project-process", () => ({
  useProjectProcess: () => ({
    data: mocks.state,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProjectProcessVersions: () => ({
    data: { versions: mocks.versions },
    isLoading: false,
  }),
  useSaveProjectProcess: () => ({ mutate: mocks.saveMutate, isPending: false }),
}));

vi.mock("../../hooks/use-project-repositories", () => ({
  useProjectRepositories: () => ({
    data: [{ id: "repo-1", fullName: "acme/toolkit" }],
  }),
}));
vi.mock("../../hooks/use-project-connections", () => ({
  useProjectConnections: () => ({ data: [] }),
}));
vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ data: [] }),
}));

function savedProcess() {
  const [input] = mocks.saveMutate.mock.calls.at(-1) as [{ process: unknown }];
  return input.process;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { current: null, invalidVersion: null };
  mocks.versions = [];
});

describe("ProjectProcessPanel", () => {
  it("shows the AgentFlow default and saves it as the first version", async () => {
    const user = userEvent.setup();
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });

    expect(screen.getByText("AgentFlow (default).")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const editor = screen.getByTestId("project-process-editor");
    await user.click(screen.getByRole("tab", { name: "Form" }));
    expect(within(editor).getAllByTestId("process-step-editor")).toHaveLength(
      2
    );
    await user.click(
      within(editor).getByRole("button", { name: "Save process" })
    );

    expect(savedProcess()).toEqual({
      toolkit: null,
      steps: [
        {
          type: ProcessStepType.AgentFlowPlan,
          id: AgentFlowStepId.Plan,
          name: "Plan",
          questions: ProcessQuestionsPolicy.Ask,
          recommendations: ProcessPlanRecommendations.Accept,
        },
        {
          type: ProcessStepType.AgentFlowExecute,
          id: AgentFlowStepId.Execute,
          name: "Implement",
          review: ProcessExecuteReview.Full,
        },
      ],
    });
  });

  it("starts from the Spec Kit preset and blocks the save until its toolkit is chosen", async () => {
    const user = userEvent.setup();
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const editor = screen.getByTestId("project-process-editor");
    await user.click(screen.getByRole("tab", { name: "Form" }));

    await user.click(within(editor).getByRole("button", { name: "Spec Kit" }));

    expect(within(editor).getAllByTestId("process-step-editor")).toHaveLength(
      7
    );
    expect(within(editor).getByTestId("process-issues")).toBeVisible();
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
  });

  it("refuses a process without steps", async () => {
    const user = userEvent.setup();
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const editor = screen.getByTestId("project-process-editor");
    await user.click(screen.getByRole("tab", { name: "Form" }));

    await user.click(
      within(editor).getByRole("button", { name: "Remove Plan" })
    );
    await user.click(
      within(editor).getByRole("button", { name: "Remove Implement" })
    );

    expect(within(editor).getByTestId("process-issues")).toBeVisible();
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
  });

  it("shows the saved process and goes back to the default", async () => {
    const user = userEvent.setup();
    mocks.state = { current: savedVersion(), invalidVersion: null };
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });

    const rows = screen.getAllByTestId("process-step-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Specify"),
      expect.stringContaining("Review"),
    ]);
    expect(rows[0]).toHaveTextContent("asks");
    expect(screen.getByText(SAVED_BY_RE)).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Use the AgentFlow default" })
    );
    expect(savedProcess()).toBeNull();
  });

  it("lets an agent step publish its file as a PRD of the project", async () => {
    const user = userEvent.setup();
    mocks.state = { current: savedVersion(), invalidVersion: null };
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByTestId("project-process-editor");
    await user.click(screen.getByRole("tab", { name: "Form" }));
    const [specify] = within(editor).getAllByTestId("process-step-editor");
    const step = specify ?? expect.fail("step editor expected");
    expect(
      within(step).queryByLabelText("Document file")
    ).not.toBeInTheDocument();

    await user.click(
      within(step).getByRole("combobox", { name: "Publish as document" })
    );
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Nothing",
      "PRD",
      "Implementation Plan",
      "Document",
    ]);
    await user.click(screen.getByRole("option", { name: "PRD" }));
    await user.type(
      within(step).getByLabelText("Document file"),
      ".agentflow-ai/work/prd.md"
    );
    await user.type(
      within(step).getByLabelText("Document title"),
      "PRD for the ticket"
    );
    await user.click(
      within(editor).getByRole("button", { name: "Save process" })
    );

    expect(savedProcess()).toMatchObject({
      steps: [
        {
          id: "specify",
          document: {
            type: ProcessDocumentType.Prd,
            path: ".agentflow-ai/work/prd.md",
            title: "PRD for the ticket",
          },
        },
        { id: "review" },
      ],
    });
  });

  it("removes the document of a step set back to publish nothing", async () => {
    const user = userEvent.setup();
    const saved = savedVersion();
    mocks.state = {
      current: {
        ...saved,
        definition: {
          toolkit: null,
          steps: [
            {
              type: ProcessStepType.Agent,
              id: "specify",
              name: "Specify",
              instruction: "/speckit-specify {{issue.title}}",
              questions: ProcessQuestionsPolicy.Ask,
              artifacts: [],
              reply: null,
              document: {
                type: ProcessDocumentType.Doc,
                path: "notes.md",
                title: "",
              },
              finish: ProcessStepFinish.None,
              timeoutMinutes: null,
            },
            {
              type: ProcessStepType.Approval,
              id: "review",
              name: "Review",
              show: ["specify"],
            },
          ],
        },
      },
      invalidVersion: null,
    };
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByTestId("project-process-editor");
    await user.click(screen.getByRole("tab", { name: "Form" }));
    const [step] = within(editor).getAllByTestId("process-step-editor");
    const specify = step ?? expect.fail("step editor expected");
    expect(within(specify).getByLabelText("Document file")).toHaveValue(
      "notes.md"
    );

    await user.click(
      within(specify).getByRole("combobox", { name: "Publish as document" })
    );
    await user.click(await screen.findByRole("option", { name: "Nothing" }));
    expect(
      within(specify).queryByLabelText("Document file")
    ).not.toBeInTheDocument();
    await user.click(
      within(editor).getByRole("button", { name: "Save process" })
    );

    expect(savedProcess()).toMatchObject({
      steps: [{ id: "specify", document: null }, { id: "review" }],
    });
  });

  it("warns when the stored version cannot be read", () => {
    mocks.state = { current: null, invalidVersion: 7 };
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });

    expect(screen.getByText(UNREADABLE_RE)).toBeVisible();
  });

  it("shows members the process and its history read-only", async () => {
    const user = userEvent.setup();
    mocks.state = { current: savedVersion(), invalidVersion: null };
    mocks.versions = [savedVersion()];
    render(<ProjectProcessPanel isAdmin={false} projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });

    expect(screen.getAllByTestId("process-step-row")).toHaveLength(2);
    expect(screen.getByText(ONLY_ADMINS_RE)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use the AgentFlow default" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(
      within(screen.getByTestId("process-history")).getByText("Version 4")
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Restore" })
    ).not.toBeInTheDocument();
  });

  it("does not offer members to customize the default", () => {
    render(<ProjectProcessPanel isAdmin={false} projectId={PROJECT_ID} />, {
      wrapper: ProcessFormEnabled,
    });

    expect(screen.getByText("AgentFlow (default).")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Customize" })
    ).not.toBeInTheDocument();
  });
});

function savedVersion(): ProjectProcessVersion {
  return {
    version: 4,
    definition: {
      toolkit: null,
      steps: [
        {
          type: ProcessStepType.Agent,
          id: "specify",
          name: "Specify",
          instruction: "/speckit-specify {{issue.title}}",
          questions: ProcessQuestionsPolicy.Ask,
          artifacts: [],
          reply: null,
          document: null,
          finish: ProcessStepFinish.None,
          timeoutMinutes: null,
        },
        {
          type: ProcessStepType.Approval,
          id: "review",
          name: "Review",
          show: ["specify"],
        },
      ],
    },
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: { id: "user-1", name: "Ada Admin" },
  };
}
