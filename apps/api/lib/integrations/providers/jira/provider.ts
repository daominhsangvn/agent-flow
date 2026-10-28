import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { conditionsReviewSignal } from "../../trigger-conditions";
import { defineIntegrationProvider } from "../../types";
import { jiraAddCommentAction, jiraTransitionIssueAction } from "./actions";
import { readJiraAttachment } from "./attachment-read";
import { attachJiraFile } from "./attachments";
import {
  JIRA_CONNECTION_FIELDS,
  JIRA_CREDENTIAL_ORIGIN_FIELDS,
  validateJiraConnection,
} from "./connection";
import { JiraEventAttribute, JiraTriggerType } from "./constants";
import { parseJiraRequest, verifyJiraRequest } from "./inbound";
import { jiraCreateIssueAction } from "./issue-actions";
import { jiraAnswerReply } from "./issue-events";
import { jiraAddLinkAction, jiraUpdateLabelsAction } from "./item-actions";
import { jiraEditOnItem, jiraReplyOnItem } from "./item-reply";
import { pollJira } from "./poll";
import { jiraProjectDefinition } from "./project";
import {
  type JiraConnectionConfig,
  type JiraSecrets,
  jiraConnectionConfigSchema,
  jiraSecretsSchema,
} from "./schemas";
import { buildJiraSetupInstructions } from "./setup-instructions";
import {
  fetchJiraIssue,
  parseJiraItemReference,
  resolveJiraManual,
} from "./source";
import {
  jiraIssueAssignedTrigger,
  jiraIssueConditionsTrigger,
  jiraIssueLabeledTrigger,
  jiraIssueMentionedTrigger,
  jiraIssueStatusChangedTrigger,
} from "./triggers";

/**
 * Jira Cloud and Data Center. A BA assigns an issue to the bot account, adds
 * a label, moves it to another status or mentions the bot (or a combination of them) -> a workflow run
 * starts; pre and post actions comment on and
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
    "Start workflows when a Jira issue is assigned to a bot account, labeled, changes status or mentions the bot (alone or combined), and comment on or transition the issue as the run progresses. Jira Cloud and Data Center.",
  docsUrl:
    "https://support.atlassian.com/jira-cloud-administration/docs/manage-webhooks/",
  connection: {
    configSchema: jiraConnectionConfigSchema,
    secretsSchema: jiraSecretsSchema,
    fields: JIRA_CONNECTION_FIELDS,
    credentialOriginFields: JIRA_CREDENTIAL_ORIGIN_FIELDS,
    validate: validateJiraConnection,
  },
  project: jiraProjectDefinition,
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
    parseItemReference: parseJiraItemReference,
    attachFile: attachJiraFile,
    readAttachment: readJiraAttachment,
  },
  reviewSignal: conditionsReviewSignal({
    triggerType: JiraTriggerType.IssueConditions,
    addedLabelsAttribute: JiraEventAttribute.AddedLabels,
    mentionedAttribute: JiraEventAttribute.Mentioned,
  }),
  answerReply: jiraAnswerReply,
  replyOnItem: jiraReplyOnItem,
  editOnItem: jiraEditOnItem,
  triggers: [
    jiraIssueAssignedTrigger,
    jiraIssueLabeledTrigger,
    jiraIssueMentionedTrigger,
    jiraIssueConditionsTrigger,
    jiraIssueStatusChangedTrigger,
  ],
  actions: [
    jiraAddCommentAction,
    jiraTransitionIssueAction,
    jiraUpdateLabelsAction,
    jiraAddLinkAction,
    jiraCreateIssueAction,
  ],
});
