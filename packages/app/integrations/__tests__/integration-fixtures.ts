import {
  IntegrationCapability,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import { WorkflowRunEvent } from "@repo/api/src/types/workflow";

/**
 * Provider catalog and connections shared by the integrations and workflows
 * tests. Shapes follow `GET /integrations/providers` and
 * `GET /integrations/connections`; ids are UUIDs because the save contracts
 * validate them as such.
 */

export const JIRA_ISSUE_ASSIGNED = "jira.issue_assigned";
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
  deliveryModes: [
    IntegrationDeliveryMode.Webhook,
    IntegrationDeliveryMode.Poll,
  ],
  capabilities: [IntegrationCapability.Triggers, IntegrationCapability.Actions],
  builtIn: false,
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
  deliveryModes: [],
  capabilities: [IntegrationCapability.Actions],
  builtIn: false,
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
  deliveryModes: [IntegrationDeliveryMode.Webhook],
  capabilities: [IntegrationCapability.Triggers],
  builtIn: true,
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

export function makeConnection(
  overrides: Partial<IntegrationConnection> = {}
): IntegrationConnection {
  return {
    managedByWorkflowId: null,
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
