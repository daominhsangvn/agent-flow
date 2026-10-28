import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectModal } from "../create-project-modal";

// Mock org users data
const mockOrgUsersQuery = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersPopoverQuery: (options: { enabled?: boolean }) => {
    mockOrgUsersQuery(options);
    return { users: [], isLoading: false };
  },
}));

// Regex constants for testing
const ADD_PROJECT_REGEX = /add project/i;
const CREATE_PROJECT_REGEX = /create project/i;
const PROJECT_NAME_LABEL_REGEX = /project name/i;
const DESCRIPTION_LABEL_REGEX = /description/i;

const TYPED_NAME = "My New Project";
const TYPED_DESCRIPTION = "A description that must survive a failure";

describe("CreateProjectModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("Org User Fetching", () => {
    it("defers the org users query until the modal is opened", async () => {
      render(<CreateProjectModal />);

      expect(mockOrgUsersQuery).toHaveBeenLastCalledWith({ enabled: false });

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));

      await waitFor(() => {
        expect(mockOrgUsersQuery).toHaveBeenLastCalledWith({ enabled: true });
      });
    });
  });

  describe("Modal Rendering", () => {
    it("should render the modal trigger button", () => {
      render(<CreateProjectModal />);

      const button = screen.getByRole("button", { name: ADD_PROJECT_REGEX });
      expect(button).toBeDefined();
    });
  });

  describe("Submit Behavior", () => {
    const getSubmitButton = () =>
      screen
        .getAllByRole("button", { name: CREATE_PROJECT_REGEX })
        .find((el) => (el as HTMLButtonElement).type === "submit") as
        | HTMLButtonElement
        | undefined;

    it("keeps the modal open and retains input when the mutation fails", async () => {
      const onCreateProject = vi.fn().mockRejectedValue(new Error("boom"));

      render(<CreateProjectModal onCreateProject={onCreateProject} />);

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));

      const nameInput = screen.getByLabelText(
        PROJECT_NAME_LABEL_REGEX
      ) as HTMLInputElement;
      const descriptionInput = screen.getByLabelText(
        DESCRIPTION_LABEL_REGEX
      ) as HTMLTextAreaElement;
      fireEvent.change(nameInput, { target: { value: TYPED_NAME } });
      fireEvent.change(descriptionInput, {
        target: { value: TYPED_DESCRIPTION },
      });

      const submitButton = getSubmitButton();
      expect(submitButton).toBeDefined();
      fireEvent.click(submitButton as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledTimes(1);
      });

      // Dialog stays mounted and the typed values are retained.
      await waitFor(() => {
        expect(
          (screen.getByLabelText(PROJECT_NAME_LABEL_REGEX) as HTMLInputElement)
            .value
        ).toBe(TYPED_NAME);
      });
      expect(
        (screen.getByLabelText(DESCRIPTION_LABEL_REGEX) as HTMLTextAreaElement)
          .value
      ).toBe(TYPED_DESCRIPTION);

      // Submit is re-enabled so the user can retry.
      await waitFor(() => {
        expect((getSubmitButton() as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("passes the trimmed submitted values to onCreateProject", async () => {
      const onCreateProject = vi.fn().mockResolvedValue(undefined);

      render(<CreateProjectModal onCreateProject={onCreateProject} />);

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));

      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });
      fireEvent.change(screen.getByLabelText(DESCRIPTION_LABEL_REGEX), {
        target: { value: TYPED_DESCRIPTION },
      });

      fireEvent.click(getSubmitButton() as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: TYPED_NAME,
            description: TYPED_DESCRIPTION,
          })
        );
      });
      expect(onCreateProject.mock.calls[0][0]).not.toHaveProperty("teamIds");
    });

    it("closes and resets the form when the mutation succeeds", async () => {
      const onCreateProject = vi.fn().mockResolvedValue(undefined);

      render(<CreateProjectModal onCreateProject={onCreateProject} />);

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });

      fireEvent.click(getSubmitButton() as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledTimes(1);
      });

      // Dialog closes: the form field is no longer in the document.
      await waitFor(() => {
        expect(screen.queryByLabelText(PROJECT_NAME_LABEL_REGEX)).toBeNull();
      });

      // Reopening shows a cleared form (state was reset on success).
      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      await waitFor(() => {
        expect(
          (screen.getByLabelText(PROJECT_NAME_LABEL_REGEX) as HTMLInputElement)
            .value
        ).toBe("");
      });
    });

    it("does not double-submit while a create is pending", async () => {
      let resolveCreate: (() => void) | undefined;
      const onCreateProject = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve;
          })
      );

      render(<CreateProjectModal onCreateProject={onCreateProject} />);
      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });

      const submitButton = getSubmitButton() as HTMLButtonElement;
      fireEvent.click(submitButton);
      fireEvent.click(submitButton);

      // Button is disabled while pending, so only one submit fires. The label
      // changes to "Creating..." during submit, so assert on the retained node
      // reference rather than re-querying by the now-stale accessible name.
      await waitFor(() => {
        expect(submitButton.disabled).toBe(true);
      });
      expect(onCreateProject).toHaveBeenCalledTimes(1);

      resolveCreate?.();
    });
  });
});
