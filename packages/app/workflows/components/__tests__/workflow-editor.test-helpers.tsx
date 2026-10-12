import type { ProjectProcessState } from "@repo/api/src/types/project-process";
import type { SaveWorkflowInput, Workflow } from "@repo/api/src/types/workflow";
import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";
import {
  jiraConnection,
  PROVIDERS,
  teamsConnection,
  webhookConnection,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  COMPUTE_TARGET_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
} from "../../__tests__/workflow-fixtures";
import type { WorkflowComputeTargetChoices } from "../../lib/workflow-editor-options";

/**
 * Shared harness of the WorkflowEditor tests (workflow-editor.test.tsx for
 * creating a workflow, workflow-editor-edit.test.tsx for editing one and for
 * a workflow's own process). Each test file mocks the editor's modules with
 * the factories below, so both read the same state.
 */

export const PLAN_ONLY_RE = /Plan only/;
export const USE_A_SPECIFIC_REPOSITORY_RE = /Use a specific repository/;
export const HTTP_ENDPOINT_AFTER_SAVE_RE =
  /gets its own URL and signing secret/;
export const REQUIRED_LABEL_RE = /Required label/;
export const TRANSITION_LABEL_RE = /^Transition/;
export const CONTINUE_ON_ERROR_RE = /Continue if this action fails/;
export const POST_ACTIONS_HELP_RE =
  /^Run when the run reaches the selected events/;
export const RUN_AS_SAVER_OPTION = "Me (whoever saves)";
export const PRE_ACTIONS_HELP =
  "Run right after a trigger fires, one after another, before the agent team starts (e.g. move the Jira issue to In Progress). If one fails, the run stops unless 'Continue if this action fails' is on.";
export const STOP_WHEN_THE_PLAN_HAS_RE =
  /Stop when the plan has open questions/;
export const ONLY_ORGANIZATION_ADMINS_CAN_CHANGE_RE =
  /Only organization admins can change workflows/;
export const OWN_PROCESS_PROJECT_DESCRIPTION_RE = /^Version 2: Analyze/;
export const DISABLED_CONNECTION_MESSAGE =
  'Trigger 1: the connection "Acme Jira" is disabled.';

export type MutateOptions = { onSuccess?: (workflow: Workflow) => void };

type EditorMocks = {
  createMutate: Mock;
  createError: Error | null;
  updateMutate: Mock;
  updateError: Error | null;
  setEnabledMutate: Mock;
  setEnabledError: Error | null;
  navigate: Mock;
  toastSuccess: Mock;
  projectProcess: ProjectProcessState | undefined;
};

type EditorModule =
  | "projectProcess"
  | "projectRepositories"
  | "integrations"
  | "projects"
  | "users"
  | "workflows"
  | "navigation"
  | "orgPath"
  | "link"
  | "sonner";

export const editorMocks: EditorMocks = {
  createMutate: vi.fn(),
  createError: null,
  updateMutate: vi.fn(),
  updateError: null,
  setEnabledMutate: vi.fn(),
  setEnabledError: null,
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  projectProcess: undefined,
};

/** Module factories for vi.mock, one per module the editor reads. */
export const editorModuleMocks: Record<
  EditorModule,
  () => Record<string, unknown>
> = {
  projectProcess: () => ({
    useProjectProcess: () => ({ data: editorMocks.projectProcess }),
  }),
  projectRepositories: () => ({
    useProjectRepositories: () => ({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  }),
  integrations: () => ({
    useIntegrationProviders: () => ({
      data: PROVIDERS,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useIntegrationConnections: () => ({
      data: [jiraConnection, teamsConnection, webhookConnection],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  }),
  projects: () => ({
    useProjects: () => ({
      data: [{ id: PROJECT_ID, name: "Web" }],
      isLoading: false,
      error: null,
    }),
  }),
  users: () => ({
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
    }),
  }),
  workflows: () => ({
    useCreateWorkflow: () => ({
      mutate: editorMocks.createMutate,
      isPending: false,
      error: editorMocks.createError,
    }),
    useUpdateWorkflow: () => ({
      mutate: editorMocks.updateMutate,
      isPending: false,
      error: editorMocks.updateError,
    }),
    useSetWorkflowEnabled: () => ({
      mutate: editorMocks.setEnabledMutate,
      isPending: false,
      error: editorMocks.setEnabledError,
    }),
  }),
  navigation: () => ({
    useNavigation: () => ({
      navigate: editorMocks.navigate,
      replace: vi.fn(),
      back: vi.fn(),
      refresh: vi.fn(),
    }),
  }),
  orgPath: () => ({
    useOrgPath: () => (path: string) => `/acme${path}`,
  }),
  link: () => ({
    Link: ({ children, href }: { children: ReactNode; href: string }) => (
      <a href={href}>{children}</a>
    ),
  }),
  sonner: () => ({
    toast: { success: editorMocks.toastSuccess, error: vi.fn() },
  }),
};

export function resetEditorMocks() {
  vi.clearAllMocks();
  editorMocks.createError = null;
  editorMocks.updateError = null;
  editorMocks.setEnabledError = null;
  editorMocks.projectProcess = undefined;
}

export const COMPUTE_TARGETS: WorkflowComputeTargetChoices = {
  options: [
    {
      id: COMPUTE_TARGET_ID,
      label: "Build Mac",
      description: "Shared with the organization",
      isOnline: true,
    },
  ],
  isLoading: false,
  error: null,
};

export async function choose(
  user: UserEvent,
  combobox: HTMLElement,
  option: string
) {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: option }));
}

export function section(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const card = heading.closest("[data-slot='card']");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No card for section ${name}`);
  }
  return card;
}

/** The row of a pre or post action, found by its heading ("Pre action 1"). */
export function actionRow(name: string): HTMLElement {
  const row = screen.getByRole("heading", { name }).closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No row for ${name}`);
  }
  return row;
}

export function lastCreateInput(): SaveWorkflowInput {
  return editorMocks.createMutate.mock.calls.at(-1)?.[0] as SaveWorkflowInput;
}

export function lastUpdateInput(): SaveWorkflowInput {
  const [variables] = editorMocks.updateMutate.mock.calls.at(-1) as [
    { input: SaveWorkflowInput },
  ];
  return variables.input;
}

export async function fillRequiredBasics(user: UserEvent) {
  await user.type(screen.getByLabelText("Name"), "Jira to PR");
  const triggers = section("Triggers");
  await choose(
    user,
    within(triggers).getByRole("combobox", { name: "Source" }),
    "Acme Jira"
  );
  await user.type(within(triggers).getByLabelText(REQUIRED_LABEL_RE), "ai");
  const agent = section("Agent team");
  await choose(
    user,
    within(agent).getByRole("combobox", { name: "Project" }),
    "Web"
  );
  await choose(
    user,
    within(agent).getByRole("combobox", { name: "Compute target" }),
    "Build Mac - Shared with the organization"
  );
}
