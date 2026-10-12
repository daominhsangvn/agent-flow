import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { defineIntegrationProvider } from "../../types";
import { jiraAddCommentAction, jiraTransitionIssueAction } from "./actions";
import {
  JIRA_CONNECTION_FIELDS,
  JIRA_CREDENTIAL_ORIGIN_FIELDS,
  validateJiraConnection,
} from "./connection";
import { parseJiraRequest, verifyJiraRequest } from "./inbound";
import { pollJira } from "./poll";
import {
  type JiraConnectionConfig,
  type JiraSecrets,
  jiraConnectionConfigSchema,
  jiraSecretsSchema,
} from "./schemas";
import { buildJiraSetupInstructions } from "./setup-instructions";
import { fetchJiraIssue, resolveJiraManual } from "./source";
import {
  jiraIssueAssignedTrigger,
  jiraIssueLabeledTrigger,
  jiraIssueMentionedTrigger,
} from "./triggers";

/**
 * Jira Cloud and Data Center. A BA assigns an issue to the bot account (or
 * adds a label) -> a workflow run starts; pre and post actions comment on and
 * transition the issue (never on their own: only the actions an admin adds to
 * a workflow write to Jira). See docs/workflows.md "Jira".
 */
export const jiraProvider = defineIntegrationProvider<
  JiraConnectionConfig,
  JiraSecrets
>({
  key: IntegrationProviderKey.Jira,
  displayName: "Jira",
  description:
    "Start workflows when a Jira issue is assigned to a bot account or labeled, and comment on or transition the issue as the run progresses. Jira Cloud and Data Center.",
  docsUrl:
    "https://support.atlassian.com/jira-cloud-administration/docs/manage-webhooks/",
  connection: {
    configSchema: jiraConnectionConfigSchema,
    secretsSchema: jiraSecretsSchema,
    fields: JIRA_CONNECTION_FIELDS,
    credentialOriginFields: JIRA_CREDENTIAL_ORIGIN_FIELDS,
    validate: validateJiraConnection,
  },
  inbound: {
    deliveryModes: [
      IntegrationDeliveryMode.Webhook,
      IntegrationDeliveryMode.Poll,
    ],
    setupInstructions: buildJiraSetupInstructions,
    verify: verifyJiraRequest,
    parse: parseJiraRequest,
    poll: pollJira,
  },
  source: {
    fetchItem: fetchJiraIssue,
    resolveManual: resolveJiraManual,
  },
  triggers: [
    jiraIssueAssignedTrigger,
    jiraIssueLabeledTrigger,
    jiraIssueMentionedTrigger,
  ],
  actions: [jiraAddCommentAction, jiraTransitionIssueAction],
});
