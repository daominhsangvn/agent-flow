/**
 * Named values of the Azure DevOps provider: trigger/action keys, service
 * hook event types, work item field reference names, event attribute keys and
 * the reasons a delivery produces no event.
 */

export const AzureDevOpsTriggerType = {
  WorkItemAssigned: "azure_devops.work_item_assigned",
  WorkItemTagged: "azure_devops.work_item_tagged",
  WorkItemMentioned: "azure_devops.work_item_mentioned",
} as const;
export type AzureDevOpsTriggerType =
  (typeof AzureDevOpsTriggerType)[keyof typeof AzureDevOpsTriggerType];

export const AzureDevOpsActionType = {
  AddComment: "azure_devops.add_comment",
  UpdateState: "azure_devops.update_state",
  CreatePullRequest: "azure_devops.create_pull_request",
  RunPipeline: "azure_devops.run_pipeline",
} as const;
export type AzureDevOpsActionType =
  (typeof AzureDevOpsActionType)[keyof typeof AzureDevOpsActionType];

/** Service hook event ids (publisher "tfs") the provider understands. */
export const AdoServiceHookEventType = {
  WorkItemCreated: "workitem.created",
  WorkItemUpdated: "workitem.updated",
  WorkItemCommented: "workitem.commented",
} as const;
export type AdoServiceHookEventType =
  (typeof AdoServiceHookEventType)[keyof typeof AdoServiceHookEventType];

/** Work item field reference names. */
export const AdoField = {
  Title: "System.Title",
  TeamProject: "System.TeamProject",
  WorkItemType: "System.WorkItemType",
  AreaPath: "System.AreaPath",
  State: "System.State",
  Tags: "System.Tags",
  AssignedTo: "System.AssignedTo",
  CreatedBy: "System.CreatedBy",
  ChangedBy: "System.ChangedBy",
  ChangedDate: "System.ChangedDate",
  CreatedDate: "System.CreatedDate",
  Description: "System.Description",
  /** A comment added by the revision (HTML), on updates and "commented" events. */
  History: "System.History",
  AcceptanceCriteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
  ReproSteps: "Microsoft.VSTS.TCM.ReproSteps",
  SystemInfo: "Microsoft.VSTS.TCM.SystemInfo",
  Priority: "Microsoft.VSTS.Common.Priority",
} as const;
export type AdoField = (typeof AdoField)[keyof typeof AdoField];

/** Keys of InboundEvent.attributes produced by this provider. */
export const AdoEventAttribute = {
  Project: "project",
  WorkItemType: "workItemType",
  AreaPath: "areaPath",
  Tags: "tags",
  State: "state",
  /** Tags added by the change (work_item_tagged events only). */
  AddedTags: "addedTags",
} as const;
export type AdoEventAttribute =
  (typeof AdoEventAttribute)[keyof typeof AdoEventAttribute];

/** Why a verified delivery produced no event. Logged on the delivery. */
export const AdoIgnoredReason = {
  InvalidPayload: "invalid_payload",
  UnsupportedEvent: "unsupported_event",
  CausedByBot: "caused_by_bot",
  BotAccountUnknown: "bot_account_unknown",
  NoRelevantChange: "no_relevant_change",
} as const;
export type AdoIgnoredReason =
  (typeof AdoIgnoredReason)[keyof typeof AdoIgnoredReason];

/** Format of a multi-line text field or a comment. */
export const AdoTextFormat = {
  Markdown: "markdown",
  Html: "html",
} as const;
export type AdoTextFormat = (typeof AdoTextFormat)[keyof typeof AdoTextFormat];

/** JSON Patch operations used to update work items. */
export const JsonPatchOperation = {
  Add: "add",
} as const;
export type JsonPatchOperation =
  (typeof JsonPatchOperation)[keyof typeof JsonPatchOperation];

/** Relation type of a file attached to a work item. */
export const ADO_ATTACHMENT_RELATION = "AttachedFile";
