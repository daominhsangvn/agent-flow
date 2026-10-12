/**
 * Named values of the Jira provider: deployment kinds, trigger/action keys,
 * webhook event names, changelog field ids, event attribute keys and the
 * reasons a delivery produces no event.
 */

export const JiraDeployment = {
  Cloud: "cloud",
  DataCenter: "data_center",
} as const;
export type JiraDeployment =
  (typeof JiraDeployment)[keyof typeof JiraDeployment];

export const JiraTriggerType = {
  IssueAssigned: "jira.issue_assigned",
  IssueLabeled: "jira.issue_labeled",
  IssueMentioned: "jira.issue_mentioned",
} as const;
export type JiraTriggerType =
  (typeof JiraTriggerType)[keyof typeof JiraTriggerType];

export const JiraActionType = {
  AddComment: "jira.add_comment",
  TransitionIssue: "jira.transition_issue",
} as const;
export type JiraActionType =
  (typeof JiraActionType)[keyof typeof JiraActionType];

/** `webhookEvent` values of Jira admin webhooks the provider handles. */
export const JiraWebhookEvent = {
  IssueCreated: "jira:issue_created",
  IssueUpdated: "jira:issue_updated",
  CommentCreated: "comment_created",
  CommentUpdated: "comment_updated",
} as const;
export type JiraWebhookEvent =
  (typeof JiraWebhookEvent)[keyof typeof JiraWebhookEvent];

/**
 * Event type recorded for Jira Automation "Send web request" deliveries with
 * the "Work item data (Jira format)" body, which carries no webhookEvent.
 */
export const JIRA_AUTOMATION_EVENT_TYPE = "jira:automation_work_item";

/** Changelog field ids the triggers react to. */
export const JiraChangelogField = {
  Assignee: "assignee",
  Labels: "labels",
} as const;
export type JiraChangelogField =
  (typeof JiraChangelogField)[keyof typeof JiraChangelogField];

/** Keys of InboundEvent.attributes produced by this provider. */
export const JiraEventAttribute = {
  ProjectKey: "projectKey",
  IssueType: "issueType",
  Labels: "labels",
  Status: "status",
  /** Labels added by the change (jira.issue_labeled events only). */
  AddedLabels: "addedLabels",
} as const;
export type JiraEventAttribute =
  (typeof JiraEventAttribute)[keyof typeof JiraEventAttribute];

/** Why a verified delivery produced no event. Logged on the delivery. */
export const JiraIgnoredReason = {
  InvalidPayload: "invalid_payload",
  UnsupportedEvent: "unsupported_event",
  CausedByBot: "caused_by_bot",
  BotAccountUnknown: "bot_account_unknown",
  NoRelevantChange: "no_relevant_change",
} as const;
export type JiraIgnoredReason =
  (typeof JiraIgnoredReason)[keyof typeof JiraIgnoredReason];

/** Where jira.add_comment posts. Only the run's source issue for now. */
export const JiraCommentTarget = {
  Source: "source",
} as const;
export type JiraCommentTarget =
  (typeof JiraCommentTarget)[keyof typeof JiraCommentTarget];

/** Header carrying the delivery id that stays the same across Jira retries. */
export const JIRA_WEBHOOK_IDENTIFIER_HEADER = "x-atlassian-webhook-identifier";
/** WebSub-style signature header of Jira admin webhooks with a secret. */
export const JIRA_HUB_SIGNATURE_HEADER = "x-hub-signature";
