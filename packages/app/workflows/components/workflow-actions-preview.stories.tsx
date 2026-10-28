import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowActionInput,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import {
  JIRA_ISSUE_ASSIGNED,
  JIRA_KEY,
  LOCAL_GIT_CREATE_PULL_REQUEST,
  localGitPullRequestProvider,
  PROVIDERS,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../integrations/__tests__/integration-fixtures";
import { WorkflowActionsPreview } from "./workflow-actions-preview";

/**
 * Under the workflow YAML editor: what the YAML does on a run, read back from
 * the save body. Per run event in lifecycle order, the actions in list order,
 * each with what it is and the connection it works on, including the one the
 * run chooses when the action names none (an instruction on the trigger's
 * connection, a pull request on every connection holding a pushed
 * repository).
 *
 * Worth seeing as a matrix because the connection line is the part that
 * differs per action and wraps on narrow widths, and the badges (before the
 * agent team, disabled, continues on error) must stay readable next to it.
 */
const meta = {
  title: "App Core/Workflows/Actions Preview",
  component: WorkflowActionsPreview,
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
    actions: jiraWorkflowActions(),
    triggers: [
      {
        connectionKey: JIRA_KEY,
        type: JIRA_ISSUE_ASSIGNED,
        config: {},
        enabled: true,
      },
    ],
    catalog: {
      providers: [...PROVIDERS, localGitPullRequestProvider],
    },
  },
} satisfies Meta<typeof WorkflowActionsPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A Jira workflow: status before the agent team, the pull request, a summary, a failure alert. */
export const JiraWorkflow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("before the agent team")).toBeVisible();
    await expect(
      canvas.getByText(
        "Connection chosen by the run: every connection that holds a repository the agent team pushed (one pull request per repository)."
      )
    ).toBeVisible();
  },
};

/** The same list in a phone-width column: long connection lines wrap under the action. */
export const Narrow: Story = {
  globals: { viewport: { value: "360-720" } },
};

/** Started from the workflow's own URL: the instruction reads the request (http). */
export const HttpTrigger: Story = {
  args: {
    actions: [
      instruction(
        "Post the plan link to the requester.",
        WorkflowRunEvent.PlanReady
      ),
    ],
    triggers: [
      { connectionKey: null, type: WEBHOOK_REQUEST, config: {}, enabled: true },
    ],
  },
};

/** Badges: a status change that may fail without stopping the run, and a disabled alert. */
export const Badges: Story = {
  args: {
    actions: [
      {
        ...instruction('Move the issue to "In Progress".'),
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: true,
      },
      { ...teamsAlert(), enabled: false },
    ],
  },
};

/** A workflow that writes nothing back. */
export const NoActions: Story = {
  args: { actions: [] },
};

function jiraWorkflowActions(): WorkflowActionInput[] {
  return [
    {
      ...instruction('Move the issue to "In Progress".'),
      stage: WorkflowActionStage.Pre,
      events: [],
    },
    {
      connectionKey: null,
      automaticConnection: true,
      type: LOCAL_GIT_CREATE_PULL_REQUEST,
      config: {},
      stage: WorkflowActionStage.Post,
      events: [WorkflowRunEvent.Succeeded],
      continueOnError: false,
      enabled: true,
    },
    instruction(
      "Summarize what was implemented for {{source.key}}: the files that changed, the tests, and the pull request ({{pr.url}}). Post it as one comment on the issue.",
      WorkflowRunEvent.ExecuteCompleted
    ),
    teamsAlert(),
  ];
}

function instruction(
  text: string,
  event: WorkflowRunEvent = WorkflowRunEvent.Succeeded
): WorkflowActionInput {
  return {
    connectionKey: null,
    automaticConnection: true,
    type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
    config: { instruction: text },
    stage: WorkflowActionStage.Post,
    events: [event],
    continueOnError: false,
    enabled: true,
  };
}

function teamsAlert(): WorkflowActionInput {
  return {
    connectionKey: TEAMS_KEY,
    automaticConnection: false,
    type: TEAMS_POST_MESSAGE,
    config: { message: "{{summary}}" },
    stage: WorkflowActionStage.Post,
    events: [WorkflowRunEvent.Failed],
    continueOnError: false,
    enabled: true,
  };
}
