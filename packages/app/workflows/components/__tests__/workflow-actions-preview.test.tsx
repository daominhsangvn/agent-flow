import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowActionInput,
  WorkflowActionStage,
  WorkflowRunEvent,
  type WorkflowTriggerInput,
} from "@repo/api/src/types/workflow";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  JIRA_KEY,
  JIRA_TRANSITION_ISSUE,
  LOCAL_GIT_CREATE_PULL_REQUEST,
  localGitPullRequestProvider,
  PROVIDERS,
  TEAMS_KEY,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import { BUILT_IN_HTTPS_CALL_TYPE } from "../../lib/workflow-yaml-schema";
import { WorkflowActionsPreview } from "../workflow-actions-preview";

describe("WorkflowActionsPreview", () => {
  it("lists the actions of each run event in lifecycle order, numbered as listed", () => {
    renderPreview([
      action({
        type: LOCAL_GIT_CREATE_PULL_REQUEST,
        events: [WorkflowRunEvent.Succeeded],
      }),
      instruction("Summarize the work.", [WorkflowRunEvent.ExecuteCompleted]),
      action({
        connectionKey: JIRA_KEY,
        automaticConnection: false,
        type: JIRA_TRANSITION_ISSUE,
        stage: WorkflowActionStage.Pre,
        events: [],
      }),
      action({
        connectionKey: TEAMS_KEY,
        automaticConnection: false,
        type: TEAMS_POST_MESSAGE,
        events: [WorkflowRunEvent.Failed, WorkflowRunEvent.PlanStarted],
      }),
    ]);

    expect(listedEvents()).toEqual([
      WorkflowRunEvent.Triggered,
      WorkflowRunEvent.PlanStarted,
      WorkflowRunEvent.ExecuteCompleted,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
    expect(actionsOn(WorkflowRunEvent.Triggered)).toEqual(["Action 3"]);
    expect(actionsOn(WorkflowRunEvent.PlanStarted)).toEqual(["Action 4"]);
    expect(actionsOn(WorkflowRunEvent.ExecuteCompleted)).toEqual(["Action 2"]);
    expect(actionsOn(WorkflowRunEvent.Succeeded)).toEqual(["Action 1"]);
    expect(actionsOn(WorkflowRunEvent.Failed)).toEqual(["Action 4"]);
    expect(
      within(eventGroup(WorkflowRunEvent.Triggered)).getByText(
        "before the agent team"
      )
    ).toBeInTheDocument();
  });

  it("lists the actions of one event in the order of the list", () => {
    renderPreview([
      instruction("Comment the summary.", [WorkflowRunEvent.Succeeded]),
      action({
        type: LOCAL_GIT_CREATE_PULL_REQUEST,
        events: [WorkflowRunEvent.Succeeded],
      }),
    ]);

    expect(actionsOn(WorkflowRunEvent.Succeeded)).toEqual([
      "Action 1",
      "Action 2",
    ]);
  });

  it("says what each action is and the connection it works on", () => {
    renderPreview([
      action({
        connectionKey: JIRA_KEY,
        automaticConnection: false,
        type: JIRA_TRANSITION_ISSUE,
      }),
      action({ automaticConnection: false, type: BUILT_IN_HTTPS_CALL_TYPE }),
      instruction("Move the issue to In Progress."),
      action({ type: LOCAL_GIT_CREATE_PULL_REQUEST }),
      action({ type: JIRA_ADD_COMMENT }),
    ]);

    expect(lineOf("Action 1")).toHaveTextContent(
      `Transition the issue (${JIRA_TRANSITION_ISSUE})On ${JIRA_KEY}: only for runs started from it (never another connection).`
    );
    expect(lineOf("Action 2")).toHaveTextContent(
      `${BUILT_IN_HTTPS_CALL_TYPE}On http: the workflow's own HTTPS call.`
    );
    expect(lineOf("Action 3")).toHaveTextContent(
      `Instruction: "Move the issue to In Progress."Reads the run's source item (${JIRA_KEY}). Read-only: list writes under connections: (e.g. source: [comment]).`
    );
    expect(lineOf("Action 4")).toHaveTextContent(
      `Create pull request (${LOCAL_GIT_CREATE_PULL_REQUEST})Connection chosen by the run: every connection that holds a repository the agent team pushed (one pull request per repository).`
    );
    expect(lineOf("Action 5")).toHaveTextContent(
      `Comment on the issue (${JIRA_ADD_COMMENT})On the run's source item, through the connection whose trigger started the run (${JIRA_KEY}).`
    );
  });

  it("names every trigger connection an instruction reads from", () => {
    renderPreview([instruction("Comment the plan.")], {
      triggers: [
        trigger(JIRA_KEY, JIRA_ISSUE_ASSIGNED),
        trigger(null, WEBHOOK_REQUEST),
      ],
    });

    expect(lineOf("Action 1")).toHaveTextContent(
      `Reads the run's source item (${JIRA_KEY} or http).`
    );
  });

  it("says what an instruction's grants let its agent read and write", () => {
    renderPreview([
      action({
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        config: {
          instruction: "Comment the plan.",
          connections: { source: ["comment"], [TEAMS_KEY]: "read" },
        },
      }),
    ]);

    expect(lineOf("Action 1")).toHaveTextContent(
      `Reads the run's source item (${JIRA_KEY}) and ${TEAMS_KEY}. May write: source: comment. Agent tools: source_item_get, connection_get_item, source_item_comment.`
    );
  });

  it("lists the tool of each granted operation and marks the ones needing approval", () => {
    renderPreview([
      action({
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        config: {
          instruction: "Announce the release.",
          connections: {
            [TEAMS_KEY]: { allow: [TEAMS_POST_MESSAGE], approval: "required" },
          },
        },
      }),
    ]);

    expect(lineOf("Action 1")).toHaveTextContent(
      "Agent tools: source_item_get, connection_get_item, microsoft_teams_post_message (approval)."
    );
  });

  it("shows the first line of an instruction, shortened", () => {
    const long = "x".repeat(120);
    renderPreview([instruction(`${long}\nSecond line.`)]);

    expect(lineOf("Action 1")).toHaveTextContent(
      `Instruction: "${"x".repeat(100)}…"`
    );
    expect(lineOf("Action 1")).not.toHaveTextContent("Second line.");
  });

  it("marks disabled actions and those that continue on error", () => {
    renderPreview([
      action({
        type: JIRA_TRANSITION_ISSUE,
        stage: WorkflowActionStage.Pre,
        events: [],
        continueOnError: true,
      }),
      action({ type: JIRA_ADD_COMMENT, enabled: false }),
    ]);

    expect(
      within(lineOf("Action 1")).getByText("continues on error")
    ).toBeInTheDocument();
    expect(within(lineOf("Action 1")).queryByText("disabled")).toBeNull();
    expect(
      within(lineOf("Action 2")).getByText("disabled")
    ).toBeInTheDocument();
  });

  it("says that a workflow without actions writes nothing back", () => {
    renderPreview([]);

    expect(
      screen.getByText(
        "No actions: a run imports the item and the agent team works on it, and nothing is written back to the source system."
      )
    ).toBeInTheDocument();
  });
});

const CATALOG = {
  providers: [...PROVIDERS, localGitPullRequestProvider],
};

const EVENT_NAME = /^(workflow|plan|input|execute)\.[a-z_]+$/;
const ACTION_NUMBER = /^Action \d+$/;

function renderPreview(
  actions: WorkflowActionInput[],
  options: { triggers?: WorkflowTriggerInput[] } = {}
) {
  render(
    <WorkflowActionsPreview
      actions={actions}
      catalog={CATALOG}
      triggers={options.triggers ?? [trigger(JIRA_KEY, JIRA_ISSUE_ASSIGNED)]}
    />
  );
}

/** A post action on workflow.completed whose connection the run chooses. */
function action(overrides: Partial<WorkflowActionInput>): WorkflowActionInput {
  return {
    connectionKey: null,
    automaticConnection: true,
    type: JIRA_ADD_COMMENT,
    config: {},
    stage: WorkflowActionStage.Post,
    events: [WorkflowRunEvent.Succeeded],
    continueOnError: false,
    enabled: true,
    ...overrides,
  };
}

function instruction(
  text: string,
  events: WorkflowRunEvent[] = [WorkflowRunEvent.Succeeded]
): WorkflowActionInput {
  return action({
    type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
    config: { instruction: text },
    events,
  });
}

function trigger(
  connectionKey: string | null,
  type: string
): WorkflowTriggerInput {
  return { connectionKey, type, config: {}, enabled: true };
}

function listedEvents(): (string | null)[] {
  return screen.getAllByText(EVENT_NAME).map((element) => element.textContent);
}

/** The list item of one run event: its name and its actions. */
function eventGroup(event: WorkflowRunEvent): HTMLElement {
  const group = screen.getByText(event).closest("li");
  if (!group) {
    throw new Error(`No group for ${event}`);
  }
  return group;
}

function actionsOn(event: WorkflowRunEvent): (string | null)[] {
  return within(eventGroup(event))
    .getAllByText(ACTION_NUMBER)
    .map((element) => element.textContent);
}

/** The first line listing the action, e.g. "Action 2". */
function lineOf(number: string): HTMLElement {
  const [label] = screen.getAllByText(number);
  const line = label?.closest("li");
  if (!line) {
    throw new Error(`No line for ${number}`);
  }
  return line;
}
