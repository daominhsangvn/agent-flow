import type { JsonObject } from "@repo/api/src/types/common";
import {
  type WorkflowAgentConfig,
  type WorkflowRunError,
  WorkflowRunStatus,
  workflowAgentConfigSchema,
  workflowRunStatusSchema,
} from "@repo/api/src/types/workflow";
import { z } from "zod";
import type {
  InboundEvent,
  InboundEventAttributeValue,
  RunRepositorySnapshot,
  SourceItem,
  SourceItemRef,
} from "@/lib/integrations/types";
import { jsonObjectSchema } from "@/lib/json-schema";

/**
 * Readers and writers for the JSON columns of `workflow_runs`
 * (`source`, `agentConfig`, `error`, `repository`). Every read goes through zod so a
 * malformed row degrades to null instead of crashing the engine.
 */

/** Shape of WorkflowRun.source (see docs/workflows.md "Ingest"). */
export type StoredRunSource = {
  item: SourceItemRef;
  inlineItem: SourceItem | null;
  actor: { id: string; displayName: string | null } | null;
  attributes: Record<string, InboundEventAttributeValue>;
  /** InboundEvent.extras of the latest occurrence; exposed to actions as sourceExtras. */
  extras: JsonObject;
  /** ISO timestamp of the occurrence. */
  occurredAt: string;
};

const nullableString = z.string().nullable().default(null);

const sourceItemRefSchema = z.object({
  provider: z.string(),
  externalId: z.string(),
  key: z.string(),
  url: nullableString,
  title: nullableString,
  container: nullableString,
});

const sourceItemSchema = sourceItemRefSchema.extend({
  title: z.string(),
  bodyMarkdown: z.string().default(""),
  itemType: nullableString,
  status: nullableString,
  priority: nullableString,
  labels: z.array(z.string()).default([]),
  reporter: nullableString,
  assignee: nullableString,
  sections: z
    .array(z.object({ title: z.string(), markdown: z.string() }))
    .default([]),
  comments: z
    .array(
      z.object({
        id: nullableString,
        parentId: nullableString,
        author: nullableString,
        createdAt: nullableString,
        bodyMarkdown: z.string(),
      })
    )
    .default([]),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        url: nullableString,
        mimeType: nullableString,
        size: z.number().nullable().default(null),
      })
    )
    .default([]),
});

const attributeValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
  z.boolean(),
  z.null(),
]);

const storedRunSourceSchema = z.object({
  item: sourceItemRefSchema,
  inlineItem: sourceItemSchema.nullable().default(null),
  actor: z
    .object({ id: z.string(), displayName: nullableString })
    .nullable()
    .default(null),
  attributes: z.record(z.string(), attributeValueSchema).default({}),
  extras: jsonObjectSchema.default({}),
  occurredAt: z.string(),
});

const runErrorSchema = z.object({ code: z.string(), message: z.string() });

const runRepositorySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  provider: z.string(),
  externalId: z.string(),
  fullName: z.string(),
  webUrl: z.string(),
  cloneUrl: z.string(),
  defaultBranch: nullableString,
  branch: nullableString,
  baseBranch: z.string(),
  pullRequest: z
    .object({ url: z.string(), number: z.number() })
    .nullable()
    .default(null),
}) satisfies z.ZodType<RunRepositorySnapshot>;
const runRepositoriesSchema = z.array(runRepositorySchema);

/** Builds the WorkflowRun.source JSON for an inbound event. */
export function buildRunSource(event: InboundEvent): JsonObject {
  const source: StoredRunSource = {
    item: event.item,
    inlineItem: event.inlineItem ?? null,
    actor: event.actor,
    attributes: event.attributes,
    // Request data the provider hands back to actions (e.g. the generic
    // webhook's callbackUrl); actions read it as sourceExtras.
    extras: toJsonObject(event.extras ?? {}),
    occurredAt: event.occurredAt.toISOString(),
  };
  return toJsonObject(source);
}

export function readRunSource(value: unknown): StoredRunSource | null {
  const parsed = storedRunSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readRunError(value: unknown): WorkflowRunError | null {
  const parsed = runErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The run's repositories (WorkflowRun.repository). A run recorded before
 * loops worked in several repositories holds one object (`legacy`), whose
 * pushed branch is the run's branchName.
 */
export function readRunRepositories(value: unknown): {
  repositories: RunRepositorySnapshot[];
  legacy: boolean;
} {
  const list = runRepositoriesSchema.safeParse(value);
  if (list.success) {
    return { repositories: list.data, legacy: false };
  }
  const single = runRepositorySchema.safeParse(value);
  return single.success
    ? { repositories: [single.data], legacy: true }
    : { repositories: [], legacy: false };
}

export function readAgentConfig(value: unknown): WorkflowAgentConfig | null {
  const parsed = workflowAgentConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Unknown stored statuses read as failed so they are treated as final. */
export function readRunStatus(value: string): WorkflowRunStatus {
  const parsed = workflowRunStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : WorkflowRunStatus.Failed;
}

/**
 * JSON round trip into a plain JSON object: drops undefined values and turns
 * Dates into ISO strings, so the value is safe for a Prisma Json column.
 */
export function toJsonObject(value: unknown): JsonObject {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value ?? {}));
  const parsed = jsonObjectSchema.safeParse(roundTripped);
  return parsed.success ? parsed.data : {};
}
