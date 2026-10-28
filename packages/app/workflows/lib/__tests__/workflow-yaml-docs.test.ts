import {
  IntegrationCapability,
  IntegrationFieldKind,
  IntegrationOperationTarget,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  WorkflowActionStage,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";
import {
  JIRA_ADD_COMMENT,
  JIRA_ISSUE_ASSIGNED,
  JIRA_KEY,
  JIRA_TRANSITION_ISSUE,
  jiraProvider,
  LOCAL_GIT_CREATE_PULL_REQUEST,
  localGitPullRequestProvider,
  makeConnection,
  makeProjectConnection,
  serverLocalGitConnection,
  TEAMS_CONNECTION_ID,
  teamsConnection,
  teamsProvider,
  webhookProvider,
} from "../../../integrations/__tests__/integration-fixtures";
import {
  COMPUTE_TARGET_ID,
  PROJECT_ID,
  RUN_AS_USER_ID,
} from "../../__tests__/workflow-fixtures";
import { parseWorkflowYaml } from "../workflow-yaml";
import {
  WORKFLOW_ACTION_EXAMPLES,
  WORKFLOW_ACTION_KEY_DOCS,
} from "../workflow-yaml-docs";
import {
  WORKFLOW_YAML_KEYS,
  type WorkflowYamlCatalog,
} from "../workflow-yaml-schema";

describe("WORKFLOW_ACTION_EXAMPLES", () => {
  it.each(
    WORKFLOW_ACTION_EXAMPLES.map((example) => [example.title, example.yaml])
  )("%s is a valid actions list", (_title, yaml) => {
    const { input, problems } = parseWorkflowYaml(workflowWith(yaml), CATALOG);

    expect(problems).toEqual([]);
    expect(input?.actions.length).toBeGreaterThan(0);
  });

  it("runs the status change before the agent team and the rest after it", () => {
    const [example] = WORKFLOW_ACTION_EXAMPLES;
    const { input } = parseWorkflowYaml(
      workflowWith(example?.yaml ?? ""),
      CATALOG
    );

    expect(
      input?.actions.map((action) => ({
        type: action.type,
        stage: action.stage,
        events: action.events,
        automaticConnection: action.automaticConnection,
      }))
    ).toEqual([
      {
        type: JIRA_TRANSITION_ISSUE,
        stage: WorkflowActionStage.Pre,
        events: [],
        automaticConnection: true,
      },
      {
        type: LOCAL_GIT_CREATE_PULL_REQUEST,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.Succeeded],
        automaticConnection: true,
      },
      {
        type: WORKFLOW_INSTRUCTION_ACTION_TYPE,
        stage: WorkflowActionStage.Post,
        events: [WorkflowRunEvent.ExecuteCompleted],
        automaticConnection: true,
      },
    ]);
  });
});

describe("WORKFLOW_ACTION_KEY_DOCS", () => {
  it("describes every key of an actions item", () => {
    for (const key of WORKFLOW_YAML_KEYS.action) {
      expect(WORKFLOW_ACTION_KEY_DOCS[key]?.info).toBeTruthy();
    }
  });
});

const RUNNER_NAME = "runner-1";

/** Jira's comment action with the options of the real provider. */
const jira: IntegrationProviderSummary = {
  ...jiraProvider,
  actions: jiraProvider.actions.map((action) => {
    if (action.key === JIRA_TRANSITION_ISSUE) {
      return {
        ...action,
        configFields: [
          {
            key: "transitionName",
            label: "Transition",
            kind: IntegrationFieldKind.Text,
            required: true,
          },
        ],
      };
    }
    return action.key === JIRA_ADD_COMMENT
      ? {
          ...action,
          configFields: [
            {
              key: "message",
              label: "Comment",
              kind: IntegrationFieldKind.Template,
              defaultValue: "{{summary}}",
            },
          ],
        }
      : action;
  }),
};

/** The built-in webhook with the HTTPS call action of the real provider. */
const webhook: IntegrationProviderSummary = {
  ...webhookProvider,
  capabilities: [IntegrationCapability.Triggers, IntegrationCapability.Actions],
  actions: [
    {
      key: "webhook.post",
      displayName: "HTTPS call",
      description: "Posts the run event as JSON.",
      configFields: [
        { key: "url", label: "URL", kind: IntegrationFieldKind.Url },
      ],
      defaultEvents: [],
      repositoryScoped: false,
      target: IntegrationOperationTarget.External,
      sourceOperation: null,
    },
  ],
};

/** The Teams connection the failure example names. */
const teamChannel = makeConnection({
  ...teamsConnection,
  id: TEAMS_CONNECTION_ID,
  provider: IntegrationProviderKey.MicrosoftTeams,
  name: "Team channel",
});

const CATALOG: WorkflowYamlCatalog = {
  providers: [jira, teamsProvider, webhook, localGitPullRequestProvider],
  projectConnections: [
    makeProjectConnection(PROJECT_ID),
    makeProjectConnection(PROJECT_ID, { key: "jira-customer" }),
    makeProjectConnection(PROJECT_ID, {
      connectionId: teamChannel.id,
      provider: teamChannel.provider,
      key: "teams-release",
      name: teamChannel.name,
      settings: {},
    }),
    makeProjectConnection(PROJECT_ID, {
      connectionId: serverLocalGitConnection.id,
      provider: serverLocalGitConnection.provider,
      key: "git",
      name: serverLocalGitConnection.name,
      settings: {},
    }),
  ],
  projects: [{ id: PROJECT_ID, name: "Web" }],
  users: [{ id: RUN_AS_USER_ID, name: "Ada Admin", email: "ada@acme.dev" }],
  runners: [{ id: COMPUTE_TARGET_ID, label: RUNNER_NAME, isOnline: true }],
};

/** A Jira workflow with the example as its actions. */
function workflowWith(actions: string): string {
  return `name: Example
project: Web
triggers:
  - connection: ${JIRA_KEY}
    type: ${JIRA_ISSUE_ASSIGNED}
    config:
      label: ai
  - connection: jira-customer
    type: ${JIRA_ISSUE_ASSIGNED}
    config:
      label: ai
agent:
  runner: ${RUNNER_NAME}
  mode: plan_and_execute
${actions}`;
}
