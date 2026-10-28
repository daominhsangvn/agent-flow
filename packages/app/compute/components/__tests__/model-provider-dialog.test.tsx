import {
  ClaudeCodeVersionChannel,
  type ComputeTargetModelProvider,
  ModelProviderMode,
} from "@repo/api/src/types/compute-target-model-provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderDialog } from "../model-provider-dialog";

const mocks = vi.hoisted(() => ({
  provider: null as ComputeTargetModelProvider | null,
  mutate: vi.fn(),
}));

vi.mock("../../hooks/use-compute-target-model-provider", () => ({
  useComputeTargetModelProvider: () => ({ data: mocks.provider, error: null }),
  useUpdateComputeTargetModelProvider: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.provider = {
    mode: ModelProviderMode.Machine,
    baseUrl: null,
    model: null,
    env: {},
    token: { isSet: false, lastFour: null },
    claudeCodeVersion: ClaudeCodeVersionChannel.Latest,
  };
});

describe("ModelProviderDialog Claude Code version", () => {
  it("shows latest by default and saves it", () => {
    renderDialog();

    expect(versionInput()).toHaveValue(ClaudeCodeVersionChannel.Latest);
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: ModelProviderMode.Machine,
        claudeCodeVersion: ClaudeCodeVersionChannel.Latest,
      }),
      expect.anything()
    );
  });

  it("saves an exact release, and latest for a blank field", () => {
    renderDialog();

    fireEvent.change(versionInput(), { target: { value: " 2.1.290 " } });
    fireEvent.click(saveButton());
    fireEvent.change(versionInput(), { target: { value: "" } });
    fireEvent.click(saveButton());

    expect(
      mocks.mutate.mock.calls.map(([input]) => input.claudeCodeVersion)
    ).toEqual(["2.1.290", ClaudeCodeVersionChannel.Latest]);
  });

  it("refuses a value the runner cannot install", () => {
    renderDialog();

    fireEvent.change(versionInput(), { target: { value: "v2.1" } });

    expect(
      screen.getByText("Use latest or a version such as 2.1.296")
    ).toBeInTheDocument();
    expect(versionInput()).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
  });
});

function renderDialog() {
  render(
    <ModelProviderDialog
      computeTargetId="0199a5f0-0000-7000-8000-0000000000c1"
      machineName="runner-1"
      onClose={vi.fn()}
    />
  );
}

function versionInput() {
  return screen.getByLabelText("Claude Code version");
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" });
}
