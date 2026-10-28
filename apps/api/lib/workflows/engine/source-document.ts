import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import type { WorkflowRunSourceDocumentType } from "@repo/api/src/types/workflow";

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
