import { OrchestratorTicketChange } from "@repo/api/src/types/orchestrator";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";
import { YamlCompletionKind } from "@repo/app/shared/lib/yaml-completion";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  JIRA_ISSUE_LABELED,
  JIRA_ISSUE_STATUS_CHANGED,
  JIRA_TRANSITION_ISSUE,
  makeProjectConnections,
  PROVIDERS,
  TEAMS_POST_MESSAGE,
  WEBHOOK_REQUEST,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  COMPUTE_TARGET_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
} from "../../__tests__/workflow-fixtures";
import {
  type WorkflowCompletionData,
  workflowYamlCompletions,
} from "../workflow-yaml-completions";

const DATA: WorkflowCompletionData = {
  providers: PROVIDERS,
  projectConnections: makeProjectConnections(PROJECT_ID),
  projects: [{ id: PROJECT_ID, name: "Web" }],
  users: [{ id: RUN_AS_USER_ID, name: "Ada Admin", email: "ada@acme.dev" }],
  runners: [
    { id: COMPUTE_TARGET_ID, label: "runner-1", isOnline: true },
    { id: "runner-2-id", label: "runner-2", isOnline: false },
  ],
  repositories: ["acme/web", "acme/api"],
};

/** The suggestions at the "§" of the text (YAML uses "|" itself). */
function at(textWithCursor: string) {
  const pos = textWithCursor.indexOf("§");
  const text = textWithCursor.replace("§", "");
  const result = workflowYamlCompletions(text, pos, DATA);
  return {
    result,
    labels: result?.options.map((option) => option.label) ?? [],
  };
}

describe("workflowYamlCompletions", () => {
  it("offers the workflow keys it does not have yet", () => {
    const { labels } = at("name: Intake\n§");

    expect(labels).toEqual([
      "description",
      "enabled",
      "project",
      "triggers",
      "agent",
      "actions",
    ]);
  });

  it("offers the built-in http and the connections that have triggers", () => {
    const { labels } = at("triggers:\n  - connection: §");

    // delivery (Teams) has no triggers.
    expect(labels).toEqual(["http", "acme-jira"]);
  });

  it("offers the action connections for actions", () => {
    const { labels } = at(
      "actions:\n  - on: workflow.failed\n    connection: §"
    );

    expect(labels).toEqual(["http", "acme-jira", "delivery"]);
  });

  it("offers the types of the item's connection only", () => {
    const trigger = at("triggers:\n  - connection: acme-jira\n    type: §");
    const action = at(
      "actions:\n  - on: workflow.triggered\n    connection: acme-jira\n    type: §\n    continueOnError: true"
    );
    const http = at("triggers:\n  - connection: http\n    type: §");

    expect(trigger.labels).toEqual([
      JIRA_ISSUE_ASSIGNED,
      JIRA_ISSUE_STATUS_CHANGED,
      JIRA_ISSUE_LABELED,
    ]);
    expect(action.labels).toEqual([JIRA_ADD_COMMENT, JIRA_TRANSITION_ISSUE]);
    expect(http.labels).toEqual([WEBHOOK_REQUEST]);
  });

  it("offers the options of the item's type inside config", () => {
    const { labels, result } = at(
      `triggers:\n  - connection: acme-jira\n    type: ${JIRA_ISSUE_ASSIGNED}\n    config:\n      label: ai\n      §`
    );

    expect(labels).toEqual(["projectKeys"]);
    expect(result?.options[0]).toMatchObject({
      kind: YamlCompletionKind.Key,
      insert: "projectKeys:\n  - ",
      detail: "Project keys",
    });
  });

  it("offers the instructions and the email, then one snippet per connection and type on a new item, then the keys", () => {
    const { result } = at("actions:\n  - §");

    const snippets = (result?.options ?? []).filter(
      (option) => option.kind === YamlCompletionKind.Snippet
    );
    expect(snippets.map((snippet) => snippet.label)).toEqual([
      "Instruction before the agent team",
      "Instruction when the implementation is done",
      "Email when an answer or an approval is needed",
      "acme-jira: Comment on the issue",
      "acme-jira: Transition the issue",
      "delivery: Post a message",
    ]);
    expect(snippets[0]?.insert).toBe(
      "on: workflow.triggered\n  instruction: #{Move the issue to In Progress.}\n  connections:\n    source: [transition]"
    );
    expect(snippets[2]?.insert).toBe(
      "on: input.needed\n  type: agentflow.email\n  config:\n    to: [#{ada@acme.dev}]"
    );
    expect(snippets[4]?.insert).toBe(
      `on: workflow.completed\n  connection: acme-jira\n  type: ${JIRA_TRANSITION_ISSUE}\n  config:\n    transition: #{In Progress}`
    );
    expect(result?.options.at(-1)?.label).toBe("config");
  });

  it("offers an email's options under config:", () => {
    expect(
      at(
        "actions:\n  - on: input.needed\n    type: agentflow.email\n    config:\n      §"
      ).labels
    ).toEqual(["to", "cc", "subject", "body"]);
  });

  it("offers every run event for on:, workflow.triggered first", () => {
    expect(at("actions:\n  - on: §").labels).toEqual([
      WorkflowRunEvent.Triggered,
      WorkflowRunEvent.Started,
      WorkflowRunEvent.PlanStarted,
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.NeedsInput,
      WorkflowRunEvent.ExecuteStarted,
      WorkflowRunEvent.ExecuteCompleted,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
  });

  it("offers the events after the trigger in a list of on:, block or flow style", () => {
    const block = at(
      `actions:\n  - connection: delivery\n    type: ${TEAMS_POST_MESSAGE}\n    on:\n      - §`
    );
    const flowText =
      "actions:\n  - on: [workflow.failed, workflow.§\n    connection: delivery";
    const flow = at(flowText);
    const older = at(
      `postActions:\n  - connection: delivery\n    type: ${TEAMS_POST_MESSAGE}\n    events:\n      - §`
    );

    expect(block.labels).toEqual([
      WorkflowRunEvent.Started,
      WorkflowRunEvent.PlanStarted,
      WorkflowRunEvent.PlanReady,
      WorkflowRunEvent.NeedsInput,
      WorkflowRunEvent.ExecuteStarted,
      WorkflowRunEvent.ExecuteCompleted,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
    // What is typed filters: the events starting with "workflow.".
    expect(flow.labels).toEqual(
      block.labels.filter((label) => label.startsWith("workflow."))
    );
    expect(older.labels).toEqual(block.labels);
    // Only the item being typed is replaced, not the list before it.
    expect(flow.result?.from).toBe(flowText.lastIndexOf("workflow."));
  });

  it("offers the projects, runners, users and modes of the agent", () => {
    expect(at("agent:\n  project: §").labels).toEqual(["Web"]);
    expect(at("agent:\n  runner: §").result?.options).toEqual([
      expect.objectContaining({ label: "runner-1", detail: "online" }),
      expect.objectContaining({ label: "runner-2", detail: "offline" }),
    ]);
    expect(at("agent:\n  runAs: §").labels).toEqual(["ada@acme.dev"]);
    expect(at("agent:\n  mode: §").labels).toEqual([
      "plan",
      "plan_and_execute",
      "orchestrated",
    ]);
    expect(at("agent:\n  repository:\n    fullName: acme/§").labels).toEqual([
      "acme/web",
      "acme/api",
    ]);
  });

  it("offers the PRD rule and its instruction, explained as such", () => {
    expect(at("agent:\n  project: Web\n  §").labels).toContain("prd");
    const { labels, result } = at("agent:\n  prd:\n    §");

    expect(labels).toEqual(["instruction"]);
    expect(result?.options[0]?.info).toContain("PRD");
    expect(result?.options[0]?.info).not.toContain("connections:");
    expect(at("agent:\n  prd:\n    instruction: PRD\n    §").labels).toEqual(
      []
    );
  });

  it("offers the ticket changes at cancelOn", () => {
    const expected = Object.values(OrchestratorTicketChange).sort();
    expect(
      at("agent:\n  orchestrator:\n    cancelOn: [§").labels.sort()
    ).toEqual(expected);
    expect(
      at("agent:\n  orchestrator:\n    cancelOn:\n      - §").labels.sort()
    ).toEqual(expected);
  });

  it("offers the keys of the status trigger config", () => {
    expect(
      at(
        `triggers:\n  - connection: acme-jira\n    type: ${JIRA_ISSUE_STATUS_CHANGED}\n    config:\n      §`
      ).labels
    ).toEqual(["from", "to", "projectKeys"]);
  });

  it("offers the orchestrator keys and the concurrency values", () => {
    expect(at("agent:\n  orchestrator:\n    §").labels).toEqual([
      "concurrency",
      "debounceSeconds",
      "turnTimeoutMinutes",
      "cancelOn",
    ]);
    expect(at("agent:\n  orchestrator:\n    concurrency: §").labels).toEqual([
      "supersede",
      "queue",
    ]);
  });

  it("offers true or false for switches", () => {
    expect(at("enabled: §").labels).toEqual(["true", "false"]);
    expect(
      at("actions:\n  - on: workflow.triggered\n    continueOnError: §").labels
    ).toEqual(["true", "false"]);
  });

  it("offers the template variables after {{", () => {
    const { labels, result } = at("agent:\n  titleTemplate: {{sour§");

    expect(labels).toEqual([
      "source.provider",
      "source.key",
      "source.title",
      "source.url",
    ]);
    expect(result?.variable).toBe(true);
    expect(result?.options[1]?.insert).toBe("source.key}}");
  });

  it("offers the process editor's suggestions inside agent.process", () => {
    const stepKeys = at(
      "agent:\n  process:\n    steps:\n      - type: approval\n        id: review\n        §"
    );
    const show = at(
      "agent:\n  process:\n    steps:\n      - type: agent\n        id: draft\n      - type: approval\n        id: review\n        show:\n          - §"
    );
    const variables = at(
      "agent:\n  process:\n    steps:\n      - type: agent\n        instruction: Read {{issue.ti§"
    );

    expect(stepKeys.labels).toEqual(["name", "show", "approve"]);
    expect(show.labels).toEqual(["draft", "review"]);
    expect(variables.labels).toEqual(["issue.title"]);
  });
});

describe("workflowYamlCompletions — project connections", () => {
  it("suggests the projects for the workflow's and a trigger's project", () => {
    expect(at("project: §").labels).toEqual(["Web"]);
    expect(
      at("triggers:\n  - connection: acme-jira\n    project: §").labels
    ).toEqual(["Web"]);
  });

  it("suggests source and the connection keys in an instruction's grants", () => {
    const { labels } = at(
      "actions:\n  - on: workflow.failed\n    instruction: Tell.\n    connections:\n      §"
    );

    expect(labels).toEqual(["source", "acme-jira", "delivery"]);
  });

  it("suggests the source writes and a connection's operations as grants", () => {
    const source = at(
      "actions:\n  - on: workflow.failed\n    instruction: Tell.\n    connections:\n      source: §"
    );
    const delivery = at(
      "actions:\n  - on: workflow.failed\n    instruction: Tell.\n    connections:\n      delivery: §"
    );

    expect(source.labels).toEqual([
      "read",
      "[comment]",
      "[transition]",
      "[comment, transition]",
      "[label]",
      "[link]",
    ]);
    expect(delivery.labels).toEqual(["read", `[${TEAMS_POST_MESSAGE}]`]);
  });
});
