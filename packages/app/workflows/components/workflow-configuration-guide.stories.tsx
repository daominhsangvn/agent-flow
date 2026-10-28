import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import {
  LOCAL_GIT_CREATE_PULL_REQUEST,
  localGitPullRequestProvider,
  makeProjectConnection,
  makeProjectConnections,
  PROVIDERS,
  serverLocalGitConnection,
} from "../../integrations/__tests__/integration-fixtures";
import { PROJECT_ID } from "../__tests__/workflow-fixtures";
import { WorkflowConfigurationGuide } from "./workflow-configuration-guide";

/**
 * The guide above the workflow YAML editor: the run events an action can run
 * on, the keys of an action, how an instruction runs and how a connection is
 * chosen, the project connections by key with every type and its options,
 * the template variables and examples to copy. It opens by itself on
 * a new workflow and stays closed on a saved one.
 *
 * Worth seeing per tab: each tab lays out different content (a definition
 * list, bullet guides, expandable types with badges, code blocks), and the
 * editor column is narrow on small screens.
 */
const meta = {
  title: "App Core/Workflows/Configuration Guide",
  component: WorkflowConfigurationGuide,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    catalog: {
      providers: [...PROVIDERS, localGitPullRequestProvider],
      projects: [{ id: PROJECT_ID, name: "Web" }],
      projectConnections: [
        ...makeProjectConnections(PROJECT_ID),
        makeProjectConnection(PROJECT_ID, {
          connectionId: serverLocalGitConnection.id,
          provider: serverLocalGitConnection.provider,
          key: "local-git",
          name: serverLocalGitConnection.name,
          settings: {},
        }),
      ],
    },
    defaultOpen: true,
  },
} satisfies Meta<typeof WorkflowConfigurationGuide>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new workflow: open on the run events, plan.started and execute.started included. */
export const RunEvents: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("plan.started")).toBeVisible();
    await expect(canvas.getByText("execute.started")).toBeVisible();
  },
};

/** The keys of an action, how an instruction runs, the connection choice and the order. */
export const Actions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Actions" }));
    await expect(
      canvas.getByRole("heading", { name: "How a connection is chosen" })
    ).toBeVisible();
  },
};

/** The project connections by key; the pull request type opened to its options and badge. */
export const Connections: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Connections" }));
    await userEvent.click(canvas.getByText(LOCAL_GIT_CREATE_PULL_REQUEST));
    await expect(canvas.getByText("every pushed repository")).toBeVisible();
  },
};

/** No project connection yet: only the built-in http and where to add one. */
export const NoConnections: Story = {
  args: {
    catalog: { providers: PROVIDERS, projects: [], projectConnections: [] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Connections" }));
    await expect(canvas.getByText("http")).toBeVisible();
  },
};

/** The examples in a phone-width column: the tabs wrap and the code scrolls. */
export const ExamplesNarrow: Story = {
  globals: { viewport: { value: "360-720" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Examples" }));
    await expect(canvas.getByText("Ticket status and a summary")).toBeVisible();
  },
};

/** A saved workflow: closed until the admin opens it. */
export const Closed: Story = {
  args: { defaultOpen: false },
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", {
      name: "Configuration guide",
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  },
};
