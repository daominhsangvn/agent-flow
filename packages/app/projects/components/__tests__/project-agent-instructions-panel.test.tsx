import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAgentInstructionsPanel } from "../project-agent-instructions-panel";

const PROJECT_ID = "0199a5f0-0000-7000-8000-0000000000d1";
const ONLY_ADMINS_RE = /Only organization admins can change them/;
const SAVED = "## Repositories\n- shop: storefront";

const mocks = vi.hoisted(() => ({
  data: undefined as string | undefined,
  isLoading: false,
  error: null as Error | null,
  saveMutate: vi.fn(),
  isPending: false,
}));

vi.mock("../../hooks/use-project-agent-instructions", () => ({
  useProjectAgentInstructions: () => ({
    data: mocks.data,
    isLoading: mocks.isLoading,
    error: mocks.error,
    refetch: vi.fn(),
  }),
  useSaveProjectAgentInstructions: () => ({
    mutate: mocks.saveMutate,
    isPending: mocks.isPending,
  }),
}));

beforeEach(() => {
  mocks.data = SAVED;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.isPending = false;
  mocks.saveMutate.mockReset();
});

describe("ProjectAgentInstructionsPanel", () => {
  it("shows the saved instructions and saves an edit", async () => {
    const user = userEvent.setup();
    render(<ProjectAgentInstructionsPanel isAdmin projectId={PROJECT_ID} />);

    const editor = screen.getByRole("textbox", { name: "Agent instructions" });
    expect(editor).toHaveValue(SAVED);
    const save = screen.getByRole("button", { name: "Save instructions" });
    expect(save).toBeDisabled();

    await user.type(editor, "\n- api: backend");
    expect(save).toBeEnabled();
    await user.click(save);

    expect(mocks.saveMutate).toHaveBeenCalledWith(
      { instructions: `${SAVED}\n- api: backend` },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it("discards an edit back to the saved instructions", async () => {
    const user = userEvent.setup();
    render(<ProjectAgentInstructionsPanel isAdmin projectId={PROJECT_ID} />);

    const editor = screen.getByRole("textbox", { name: "Agent instructions" });
    await user.clear(editor);
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(editor).toHaveValue(SAVED);
    expect(mocks.saveMutate).not.toHaveBeenCalled();
  });

  it("offers a retry when the instructions cannot be loaded", () => {
    mocks.data = undefined;
    mocks.error = new Error("boom");
    render(<ProjectAgentInstructionsPanel isAdmin projectId={PROJECT_ID} />);

    expect(
      screen.getByText("Couldn't load the agent instructions")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Agent instructions" })
    ).not.toBeInTheDocument();
  });

  it("shows members the instructions read-only", () => {
    render(
      <ProjectAgentInstructionsPanel isAdmin={false} projectId={PROJECT_ID} />
    );

    const editor = screen.getByRole("textbox", { name: "Agent instructions" });
    expect(editor).toHaveValue(SAVED);
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Save instructions" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(ONLY_ADMINS_RE)).toBeVisible();
  });
});
