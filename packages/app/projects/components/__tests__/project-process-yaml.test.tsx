import {
  ProcessQuestionsPolicy,
  ProcessStepFinish,
  ProcessStepType,
  type ProjectProcessState,
} from "@repo/api/src/types/project-process";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProcessPanel } from "../project-process-panel";
import { ProcessFormEnabled } from "./process-form-flag.test-helpers";

/**
 * The YAML view of the project process editor (the default view): the
 * process as YAML, edited text parsed back into the draft, comments kept on
 * save, syntax errors blocking the save, and the form view next to it.
 */

const PROJECT_ID = "project-1";
const YAML_LINE_RE = /^YAML line 3:/;

const mocks = vi.hoisted(() => ({
  state: undefined as ProjectProcessState | undefined,
  saveMutate: vi.fn(),
}));

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
    data: { versions: [] },
    isLoading: false,
  }),
  useSaveProjectProcess: () => ({ mutate: mocks.saveMutate, isPending: false }),
}));
vi.mock("../../hooks/use-project-repositories", () => ({
  useProjectRepositories: () => ({
    data: [{ id: "repo-1", fullName: "brenock/ip-okf" }],
  }),
}));
vi.mock("../../hooks/use-project-connections", () => ({
  useProjectConnections: () => ({ data: [] }),
}));
vi.mock("@repo/app/integrations/hooks/use-integrations", () => ({
  useIntegrationProviders: () => ({ data: [] }),
}));

const SAVED_YAML = [
  "# Requirement analysis (BA)",
  "steps:",
  "  - type: agent",
  "    id: analyze",
  "    name: Analyze",
  "    instruction: /ba-analyze {{issue.file}}",
  "    questions: ask",
  "    finish: none",
  "",
].join("\n");

function savedProcess() {
  const [input] = mocks.saveMutate.mock.calls.at(-1) as [{ process: unknown }];
  return input.process;
}

/** `form`: with the Form tab (its flag on); the default is YAML only. */
async function openEditor({ form = false }: { form?: boolean } = {}) {
  const user = userEvent.setup();
  render(
    <ProjectProcessPanel isAdmin projectId={PROJECT_ID} />,
    form ? { wrapper: ProcessFormEnabled } : undefined
  );
  await user.click(screen.getByRole("button", { name: "Customize" }));
  const editor = screen.getByTestId("project-process-editor");
  return { user, editor };
}

async function replaceYaml(
  user: ReturnType<typeof userEvent.setup>,
  text: string
) {
  const yaml = await screen.findByLabelText("Process YAML");
  await user.clear(yaml);
  await user.click(yaml);
  await user.paste(text);
  return yaml;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { current: null, invalidVersion: null };
});

describe("ProjectProcessPanel: the YAML view", () => {
  it("opens on the process as YAML, without the form", async () => {
    await openEditor();

    const yaml = await screen.findByLabelText("Process YAML");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(yaml).toHaveValue(
      [
        "steps:",
        "  - type: agentflow.plan",
        "    id: plan",
        "    name: Plan",
        "    questions: ask",
        "    recommendations: accept",
        "  - type: agentflow.execute",
        "    id: execute",
        "    name: Implement",
        "    review: full",
        "",
      ].join("\n")
    );
  });

  it("saves what the YAML describes, with the YAML itself so its comments come back", async () => {
    const { user, editor } = await openEditor();

    await replaceYaml(user, SAVED_YAML);
    await user.click(
      within(editor).getByRole("button", { name: "Save process" })
    );

    expect(savedProcess()).toEqual({
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
          finish: ProcessStepFinish.None,
          timeoutMinutes: null,
        },
      ],
      source: SAVED_YAML,
    });
  });

  it("shows a saved process's own YAML, comments included", async () => {
    mocks.state = {
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
              finish: ProcessStepFinish.None,
              timeoutMinutes: null,
            },
          ],
          source: SAVED_YAML,
        },
        createdAt: "2026-10-09T09:00:00.000Z",
        createdBy: null,
      },
      invalidVersion: null,
    };
    const user = userEvent.setup();
    render(<ProjectProcessPanel isAdmin projectId={PROJECT_ID} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByLabelText("Process YAML")).toHaveValue(
      SAVED_YAML
    );
  });

  it("blocks the save and the form while the YAML does not parse", async () => {
    const { user, editor } = await openEditor({ form: true });

    await replaceYaml(user, "steps:\n  - type: agent\n  bad: [\n");

    expect(within(editor).getByTestId("process-issues")).toHaveTextContent(
      YAML_LINE_RE
    );
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Form" })).toBeDisabled();
  });

  it("lists the schema's problems for YAML that parses", async () => {
    const { user, editor } = await openEditor();

    await replaceYaml(
      user,
      "steps:\n  - type: agent\n    id: a\n    name: A\n    instruction: x\n    questions: maybe\n"
    );

    expect(within(editor).getByTestId("process-issues")).toHaveTextContent(
      "Step 1 (A) · questions"
    );
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
  });

  it("switches to the form, whose edits regenerate the YAML without the old comments", async () => {
    const { user, editor } = await openEditor({ form: true });
    await replaceYaml(user, SAVED_YAML);

    await user.click(screen.getByRole("tab", { name: "Form" }));
    const [step] = within(editor).getAllByTestId("process-step-editor");
    const name = within(step ?? editor).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Analyse");
    await user.click(screen.getByRole("tab", { name: "YAML" }));

    const yaml = await screen.findByLabelText("Process YAML");
    expect(yaml).toHaveValue(
      [
        "steps:",
        "  - type: agent",
        "    id: analyze",
        "    name: Analyse",
        "    instruction: /ba-analyze {{issue.file}}",
        "    questions: ask",
        "    finish: none",
        "",
      ].join("\n")
    );
  });

  it("stays up while a step is half typed, and takes the step once it is complete", async () => {
    const { user, editor } = await openEditor({ form: true });

    const yaml = await replaceYaml(user, "steps:\n  - ");

    expect(yaml).toHaveValue("steps:\n  - ");
    expect(within(editor).getByTestId("process-issues")).toHaveTextContent(
      "Step 1"
    );
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Form" })).toBeDisabled();

    await user.paste("type: approval\n    id: ok\n    name: OK\n");

    expect(within(editor).queryByTestId("process-issues")).toBeNull();
    expect(screen.getByRole("tab", { name: "Form" })).toBeEnabled();
  });

  it("stays up for YAML without steps", async () => {
    const { user, editor } = await openEditor({ form: true });

    await replaceYaml(user, "# Nothing yet\ntoolkit: null\n");

    expect(within(editor).getByTestId("process-issues")).toHaveTextContent(
      "steps"
    );
    expect(
      within(editor).getByRole("button", { name: "Save process" })
    ).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Form" })).toBeDisabled();
  });
});
