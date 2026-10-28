import {
  IntegrationCapability,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationOperationTarget,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import type { ProjectConnection } from "@repo/api/src/types/project-connection";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";

/**
 * Provider catalog and connections shared by the integrations and workflows
 * tests. Shapes follow `GET /integrations/providers` and
 * `GET /integrations/connections`; ids are UUIDs because the save contracts
 * validate them as such.
 */

export const JIRA_ISSUE_ASSIGNED = "jira.issue_assigned";
export const JIRA_ISSUE_STATUS_CHANGED = "jira.issue_status_changed";
export const JIRA_ISSUE_LABELED = "jira.issue_labeled";
export const JIRA_ADD_COMMENT = "jira.add_comment";
export const JIRA_TRANSITION_ISSUE = "jira.transition_issue";
export const TEAMS_POST_MESSAGE = "microsoft_teams.post_message";
export const WEBHOOK_REQUEST = "webhook.request";

export const JIRA_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
export const TEAMS_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
export const WEBHOOK_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

export const DEPLOYMENT_CLOUD = "cloud";
export const DEPLOYMENT_DATA_CENTER = "data_center";

export const jiraProvider: IntegrationProviderSummary = {
  key: IntegrationProviderKey.Jira,
  displayName: "Jira",
  description: "Jira Cloud and Data Center issues.",
  docsUrl: "https://docs.example.com/jira",
  connectionFields: [
    {
      key: "deployment",
      label: "Deployment",
      kind: IntegrationFieldKind.Select,
      required: true,
      defaultValue: DEPLOYMENT_CLOUD,
      options: [
        { value: DEPLOYMENT_CLOUD, label: "Cloud" },
        { value: DEPLOYMENT_DATA_CENTER, label: "Data Center" },
      ],
    },
    {
      key: "siteUrl",
      label: "Site URL",
      kind: IntegrationFieldKind.Url,
      required: true,
    },
    {
      key: "email",
      label: "Bot email",
      kind: IntegrationFieldKind.Email,
      required: true,
      showWhen: { field: "deployment", equals: DEPLOYMENT_CLOUD },
    },
    {
      key: "apiToken",
      label: "API token",
      kind: IntegrationFieldKind.Secret,
      required: true,
    },
  ],
  credentialOriginFields: ["deployment", "siteUrl"],
  projectSettingsFields: [],
  deliveryModes: [
    IntegrationDeliveryMode.Webhook,
    IntegrationDeliveryMode.Poll,
  ],
  capabilities: [IntegrationCapability.Triggers, IntegrationCapability.Actions],
  builtIn: false,
  providedByServer: false,
  triggers: [
    {
      key: JIRA_ISSUE_ASSIGNED,
      displayName: "Issue assigned to the bot",
      description: "Starts when an issue is assigned to the bot account.",
      configFields: [
        {
          key: "projectKeys",
          label: "Project keys",
          kind: IntegrationFieldKind.StringList,
        },
        {
          key: "label",
          label: "Required label",
          kind: IntegrationFieldKind.Text,
          required: true,
        },
      ],
      manualRun: { label: "Issue key", placeholder: "PROJ-123" },
    },
    {
      key: JIRA_ISSUE_STATUS_CHANGED,
      displayName: "Issue status changed",
      description: "Starts when an issue moves to another status.",
      configFields: [
        {
          key: "from",
          label: "From statuses",
          kind: IntegrationFieldKind.StringList,
        },
        {
          key: "to",
          label: "To statuses",
          kind: IntegrationFieldKind.StringList,
        },
        {
          key: "projectKeys",
          label: "Project keys",
          kind: IntegrationFieldKind.StringList,
        },
      ],
      manualRun: null,
    },
    {
      key: JIRA_ISSUE_LABELED,
      displayName: "Issue labeled",
      description: "Starts when a label is added or removed.",
      configFields: [
        {
          key: "label",
          label: "Label",
          kind: IntegrationFieldKind.Text,
          required: true,
        },
        {
          key: "change",
          label: "Change",
          kind: IntegrationFieldKind.Select,
          options: [
            { value: "added", label: "Added" },
            { value: "removed", label: "Removed" },
          ],
        },
      ],
      manualRun: null,
    },
  ],
  actions: [
    {
      key: JIRA_ADD_COMMENT,
      displayName: "Comment on the issue",
      description: "Adds a comment to the source issue.",
      configFields: [
        {
          key: "body",
          label: "Comment",
          kind: IntegrationFieldKind.Template,
          required: true,
          defaultValue: "{{summary}}",
        },
      ],
      defaultEvents: [
        WorkflowRunEvent.Succeeded,
        WorkflowRunEvent.Failed,
        "run.unknown_event",
      ],
      repositoryScoped: false,
      target: IntegrationOperationTarget.SourceItem,
      sourceOperation: "comment",
    },
    {
      key: JIRA_TRANSITION_ISSUE,
      displayName: "Transition the issue",
      description: "Moves the source issue through a workflow transition.",
      configFields: [
        {
          key: "transition",
          label: "Transition",
          kind: IntegrationFieldKind.Text,
          required: true,
          placeholder: "In Progress",
        },
      ],
      // run.triggered is a pre action event; post actions never preselect it.
      defaultEvents: [WorkflowRunEvent.Triggered, WorkflowRunEvent.Succeeded],
      repositoryScoped: false,
      target: IntegrationOperationTarget.SourceItem,
      sourceOperation: "transition",
    },
  ],
};

export const teamsProvider: IntegrationProviderSummary = {
  key: IntegrationProviderKey.MicrosoftTeams,
  displayName: "Microsoft Teams",
  description: "Post to a Teams channel through a Workflows webhook.",
  docsUrl: null,
  connectionFields: [
    {
      key: "webhookUrl",
      label: "Workflows webhook URL",
      kind: IntegrationFieldKind.Secret,
      required: true,
    },
  ],
  credentialOriginFields: [],
  projectSettingsFields: [],
  deliveryModes: [],
  capabilities: [IntegrationCapability.Actions],
  builtIn: false,
  providedByServer: false,
  triggers: [],
  actions: [
    {
      key: TEAMS_POST_MESSAGE,
      displayName: "Post a message",
      description: "Posts an Adaptive Card to the channel.",
      configFields: [
        {
          key: "message",
          label: "Message",
          kind: IntegrationFieldKind.Template,
          defaultValue: "{{summary}}",
        },
      ],
      defaultEvents: [WorkflowRunEvent.Succeeded],
      repositoryScoped: false,
      target: IntegrationOperationTarget.External,
      sourceOperation: null,
    },
  ],
};

export const webhookProvider: IntegrationProviderSummary = {
  key: IntegrationProviderKey.Webhook,
  displayName: "Webhook (HTTPS)",
  description: "Generic signed HTTPS requests.",
  docsUrl: null,
  // The callback URL may embed a token, so it is a write-only secret field.
  connectionFields: [
    {
      key: "callbackUrl",
      label: "Default callback URL",
      kind: IntegrationFieldKind.Secret,
      required: false,
    },
    {
      key: "signingSecret",
      label: "Outbound signing secret",
      kind: IntegrationFieldKind.Secret,
      required: false,
    },
  ],
  credentialOriginFields: [],
  projectSettingsFields: [],
  deliveryModes: [IntegrationDeliveryMode.Webhook],
  capabilities: [IntegrationCapability.Triggers],
  builtIn: true,
  providedByServer: false,
  triggers: [
    {
      key: WEBHOOK_REQUEST,
      displayName: "HTTPS request",
      description: "Starts when a signed request arrives.",
      configFields: [],
      manualRun: { label: "Request body (JSON)", placeholder: '{"id":"1"}' },
    },
  ],
  actions: [],
};

export const PROVIDERS: IntegrationProviderSummary[] = [
  jiraProvider,
  teamsProvider,
  webhookProvider,
];

export const LOCAL_GIT_CONNECTION_ID = "55555555-5555-4555-8555-555555555555";

/** Local Git as a server that provides its connection to every organization serves it. */
export const serverLocalGitProvider: IntegrationProviderSummary = {
  key: IntegrationProviderKey.LocalGit,
  displayName: "Local Git",
  description: "Git repositories hosted on your own machine.",
  docsUrl: null,
  connectionFields: [
    {
      key: "serverUrl",
      label: "Server URL",
      kind: IntegrationFieldKind.Url,
      required: true,
    },
    {
      key: "token",
      label: "Access token",
      kind: IntegrationFieldKind.Secret,
      required: true,
    },
  ],
  credentialOriginFields: ["serverUrl"],
  projectSettingsFields: [],
  deliveryModes: [],
  capabilities: [
    IntegrationCapability.Actions,
    IntegrationCapability.Repositories,
    IntegrationCapability.RepositoryCreation,
  ],
  builtIn: false,
  providedByServer: true,
  triggers: [],
  actions: [],
};

export function makeConnection(
  overrides: Partial<IntegrationConnection> = {}
): IntegrationConnection {
  return {
    managedByWorkflowId: null,
    providedByServer: false,
    id: JIRA_CONNECTION_ID,
    provider: IntegrationProviderKey.Jira,
    name: "Acme Jira",
    status: IntegrationConnectionStatus.Active,
    config: {
      deployment: DEPLOYMENT_CLOUD,
      siteUrl: "https://acme.atlassian.net",
      email: "bot@acme.dev",
    },
    secretFields: { apiToken: { isSet: true, lastFour: "x9Kd" } },
    account: { externalAccountId: "acc-1", displayName: "AgentFlow Bot" },
    deliveryMode: IntegrationDeliveryMode.Webhook,
    pollIntervalSeconds: 120,
    inboundUrl: "https://api.acme.dev/webhooks/integrations/key-1",
    lastPolledAt: null,
    lastDeliveryAt: null,
    lastValidatedAt: null,
    lastError: null,
    usageCount: 0,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    ...overrides,
  };
}

export const jiraConnection = makeConnection();

export const teamsConnection = makeConnection({
  id: TEAMS_CONNECTION_ID,
  provider: IntegrationProviderKey.MicrosoftTeams,
  name: "Delivery channel",
  config: {},
  secretFields: { webhookUrl: { isSet: true, lastFour: "abcd" } },
  account: null,
  deliveryMode: IntegrationDeliveryMode.None,
  inboundUrl: null,
});

export const webhookConnection = makeConnection({
  id: WEBHOOK_CONNECTION_ID,
  provider: IntegrationProviderKey.Webhook,
  name: "Intake webhook",
  config: {},
  secretFields: {
    callbackUrl: { isSet: true, lastFour: "/c4f" },
    signingSecret: { isSet: true, lastFour: "Qk9=" },
  },
  account: null,
});

export const serverLocalGitConnection = makeConnection({
  id: LOCAL_GIT_CONNECTION_ID,
  provider: IntegrationProviderKey.LocalGit,
  name: "Local Git",
  providedByServer: true,
  config: { serverUrl: "http://localhost:3300", runnerUrl: "", owner: "" },
  secretFields: { token: { isSet: true, lastFour: "f00d" } },
  account: { externalAccountId: "1", displayName: "agentflow" },
  deliveryMode: IntegrationDeliveryMode.None,
  inboundUrl: null,
});

export const LOCAL_GIT_CREATE_PULL_REQUEST = "local_git.create_pull_request";

/**
 * Local Git with its pull request action, which is repository scoped: a run
 * opens one pull request in every repository the agent team pushed.
 */
export const localGitPullRequestProvider: IntegrationProviderSummary = {
  ...serverLocalGitProvider,
  actions: [
    {
      key: LOCAL_GIT_CREATE_PULL_REQUEST,
      displayName: "Create pull request",
      description:
        "Opens a Local Git pull request in each project repository the agent team pushed a branch to.",
      configFields: [
        {
          key: "title",
          label: "Title",
          kind: IntegrationFieldKind.Template,
          required: true,
          defaultValue: "{{source.key}}: {{source.title}}",
        },
        {
          key: "targetBranch",
          label: "Target branch",
          kind: IntegrationFieldKind.Text,
          placeholder: "main",
          description:
            "Leave empty to merge into the branch the run started from.",
        },
        {
          key: "draft",
          label: "Open as draft",
          kind: IntegrationFieldKind.Boolean,
          defaultValue: false,
        },
      ],
      defaultEvents: [WorkflowRunEvent.Succeeded],
      repositoryScoped: true,
      target: IntegrationOperationTarget.Repository,
      sourceOperation: null,
    },
  ],
};

/** Keys of the project connections the workflow fixtures use. */
export const JIRA_KEY = "acme-jira";
export const TEAMS_KEY = "delivery";

/** A project connection of `projectId` to an organization connection. */
export function makeProjectConnection(
  projectId: string,
  overrides: Partial<ProjectConnection> = {}
): ProjectConnection {
  return {
    id: `pc-${overrides.key ?? JIRA_KEY}-${projectId}`,
    projectId,
    connectionId: JIRA_CONNECTION_ID,
    connectionName: "Acme Jira",
    provider: IntegrationProviderKey.Jira,
    key: JIRA_KEY,
    name: "Acme Jira",
    settings: { projectKeys: ["PROJ"] },
    createdAt: new Date("2026-10-13T00:00:00.000Z"),
    updatedAt: new Date("2026-10-13T00:00:00.000Z"),
    ...overrides,
  };
}

/** The Jira and Teams project connections of a project. */
export function makeProjectConnections(projectId: string): ProjectConnection[] {
  return [
    makeProjectConnection(projectId),
    makeProjectConnection(projectId, {
      connectionId: TEAMS_CONNECTION_ID,
      connectionName: "Delivery channel",
      provider: IntegrationProviderKey.MicrosoftTeams,
      key: TEAMS_KEY,
      name: "Delivery channel",
      settings: {},
    }),
  ];
}
