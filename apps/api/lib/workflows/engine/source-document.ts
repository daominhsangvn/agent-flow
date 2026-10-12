import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import type { WorkflowRunSourceDocumentType } from "@repo/api/src/types/workflow";
import type { SourceItem } from "@/lib/integrations/types";

const NON_ALPHANUMERIC_RE = /[^a-z0-9]/g;

/** Item types (lowercase, letters and digits only) that name a PRD. */
const PRD_ITEM_TYPES: ReadonlySet<string> = new Set([
  "prd",
  "productrequirement",
  "productrequirements",
  "productrequirementdocument",
  "productrequirementsdocument",
]);

export function isPrdItemType(itemType: string | null | undefined): boolean {
  if (!itemType) {
    return false;
  }
  return PRD_ITEM_TYPES.has(
    itemType.toLowerCase().replaceAll(NON_ALPHANUMERIC_RE, "")
  );
}

/**
 * The document a run imports its source item as. A product requirement (an
 * HTTP request with `"type": "prd"`, a tracker item of type "PRD") becomes a
 * PRD: the plan is generated from it, like the "Generate plan" flow of a PRD
 * written in AgentFlow. Anything else (a bug, a story, a task) is an Issue.
 */
export function sourceDocumentType(
  item: Pick<SourceItem, "itemType">
): WorkflowRunSourceDocumentType {
  return isPrdItemType(item.itemType) ? DocumentType.Prd : DocumentType.Feature;
}

/**
 * Status of a newly imported source document: an Issue is in progress; a PRD
 * handed to the agents for implementation is approved.
 */
export function importedSourceStatus(
  type: WorkflowRunSourceDocumentType
): DocumentStatus | IssueStatus {
  return type === DocumentType.Prd
    ? DocumentStatus.Approved
    : IssueStatus.InProgress;
}

/**
 * Status once the implementation pull request is open: the Issue moves to in
 * review, the PRD is executed (delivered for review).
 */
export function deliveredSourceStatus(
  type: string | null | undefined
): DocumentStatus | IssueStatus {
  return type === DocumentType.Prd
    ? DocumentStatus.Executed
    : IssueStatus.InReview;
}

/** Display name of the run's source document type ("PRD" or "Issue"). */
export function sourceDocumentLabel(type: string | null | undefined): string {
  return type === DocumentType.Prd ? "PRD" : "Issue";
}

/** The type of a stored source document; legacy rows without one are Issues. */
export function toSourceDocumentType(
  subtype: string | null | undefined
): WorkflowRunSourceDocumentType {
  return subtype === DocumentType.Prd ? DocumentType.Prd : DocumentType.Feature;
}
