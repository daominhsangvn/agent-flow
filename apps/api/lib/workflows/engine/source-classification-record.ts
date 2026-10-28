import { DocumentType } from "@repo/api/src/types/document";
import {
  type WorkflowRunSourceClassification,
  WorkflowRunSourceClassificationOrigin,
} from "@repo/api/src/types/workflow";
import { z } from "zod";

/**
 * WorkflowRun.sourceClassification, the record of the PRD instruction's
 * classification (source-classification.ts): the desktop command while the
 * run's computer decides, then the decision. Kept apart from the engine so
 * the run page reads it without loading the dispatch path.
 */

export const ClassificationStatus = {
  Pending: "pending",
  Decided: "decided",
} as const;

const pendingClassificationSchema = z.object({
  status: z.literal(ClassificationStatus.Pending),
  /** The desktop command the computer answers on. */
  commandId: z.uuid(),
  requestedAt: z.iso.datetime(),
});

const decidedClassificationSchema = z.object({
  status: z.literal(ClassificationStatus.Decided),
  type: z.enum([DocumentType.Prd, DocumentType.Feature]),
  origin: z.enum(WorkflowRunSourceClassificationOrigin),
  reason: z.string(),
  /** Claude Code's own cost of the decision; null when unknown. */
  costUsd: z.number().nonnegative().nullable(),
  decidedAt: z.iso.datetime(),
});

const storedClassificationSchema = z.discriminatedUnion("status", [
  pendingClassificationSchema,
  decidedClassificationSchema,
]);

export type PendingClassification = z.infer<typeof pendingClassificationSchema>;
export type DecidedClassification = z.infer<typeof decidedClassificationSchema>;
export type StoredClassification = z.infer<typeof storedClassificationSchema>;

/** The stored record, or null for none (or one this version cannot read). */
export function readStoredClassification(
  value: unknown
): StoredClassification | null {
  const parsed = storedClassificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The run page's view of a stored classification; null while pending. */
export function toSourceClassificationView(
  value: unknown
): WorkflowRunSourceClassification | null {
  const stored = readStoredClassification(value);
  if (stored?.status !== ClassificationStatus.Decided) {
    return null;
  }
  const { type, origin, reason } = stored;
  return { type, origin, reason };
}
