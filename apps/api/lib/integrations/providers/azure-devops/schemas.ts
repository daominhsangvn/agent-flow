import { z } from "zod";
import { jsonObjectSchema } from "@/lib/json-schema";
import { AdoField } from "./constants";

/**
 * Zod schemas for the connection config and for the Azure DevOps payloads the
 * provider reads (service hook envelopes, REST 7.1 work items, updates,
 * comments, WIQL results, connectionData). Payload schemas are loose: only
 * the properties the provider uses are declared, everything else passes. In
 * service hook payloads only the event type and the work item id are
 * essential; every other declared property falls back to null when it has
 * an unexpected shape, so one odd value never drops a whole delivery.
 */

export const ORGANIZATION_URL_HINT =
  "Use https://dev.azure.com/{organization} or https://{organization}.visualstudio.com";

export const adoConnectionConfigSchema = z.object({
  organizationUrl: z
    .string()
    .trim()
    .min(1, "Enter the organization URL")
    .refine((value) => normalizeOrganizationUrl(value) !== null, {
      message: ORGANIZATION_URL_HINT,
    })
    .transform((value) => normalizeOrganizationUrl(value) ?? value),
});
export type AdoConnectionConfig = z.infer<typeof adoConnectionConfigSchema>;

export const adoSecretsSchema = z.object({
  pat: z.string().trim().min(1, "Enter the personal access token"),
});
export type AdoSecrets = z.infer<typeof adoSecretsSchema>;

/** Payload values that degrade to null instead of failing the payload. */
const lenientTextSchema = z.string().nullish().catch(null);
const lenientIntSchema = z.number().int().nullish().catch(null);
const lenientFieldMapSchema = jsonObjectSchema.nullish().catch(null);

/** IdentityRef as returned by REST 7.x and in service hook `revisedBy`. */
export const adoIdentityRefSchema = z.looseObject({
  id: lenientTextSchema,
  uniqueName: lenientTextSchema,
  displayName: lenientTextSchema,
  /** "Display Name <email>" (service hook revisedBy). */
  name: lenientTextSchema,
  descriptor: lenientTextSchema,
});
export type AdoIdentityRef = z.infer<typeof adoIdentityRefSchema>;

/** `{oldValue, newValue}` of one field in a work item update. */
export const adoFieldChangeSchema = z.looseObject({
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});
export type AdoFieldChange = z.infer<typeof adoFieldChangeSchema>;

export const adoRelationSchema = z.looseObject({
  rel: lenientTextSchema,
  url: lenientTextSchema,
  attributes: z
    .looseObject({
      name: lenientTextSchema,
      resourceSize: z.number().nullish().catch(null),
      /** The title of a Hyperlink relation. */
      comment: lenientTextSchema,
    })
    .nullish()
    .catch(null),
});
export type AdoRelation = z.infer<typeof adoRelationSchema>;

export const adoWorkItemSchema = z.looseObject({
  id: z.number().int().positive(),
  rev: lenientIntSchema,
  fields: lenientFieldMapSchema,
  relations: z.array(adoRelationSchema).nullish().catch(null),
  /** Present on newer API versions: field reference name -> "markdown" | "html". */
  multilineFieldsFormat: z.record(z.string(), z.string()).nullish().catch(null),
});
export type AdoWorkItem = z.infer<typeof adoWorkItemSchema>;

/** WorkItemUpdate: REST `updates` list entries and the `workitem.updated` resource. */
export const adoWorkItemUpdateSchema = z.looseObject({
  /** The UPDATE id, not the work item id. */
  id: lenientIntSchema,
  workItemId: lenientIntSchema,
  rev: lenientIntSchema,
  revisedBy: z.unknown().optional(),
  revisedDate: lenientTextSchema,
  /** A change that is not an {oldValue, newValue} object reads as null. */
  fields: z
    .record(z.string(), adoFieldChangeSchema.nullable().catch(null))
    .nullish()
    .catch(null),
  /** Service hooks only: full snapshot of the work item at this revision. */
  revision: z
    .looseObject({
      id: lenientIntSchema,
      rev: lenientIntSchema,
      fields: lenientFieldMapSchema,
    })
    .nullish()
    .catch(null),
});
export type AdoWorkItemUpdate = z.infer<typeof adoWorkItemUpdateSchema>;

export const adoServiceHookEnvelopeSchema = z.looseObject({
  /** Event id; identical across service hook retries. */
  id: lenientTextSchema,
  notificationId: z.union([z.number(), z.string()]).nullish().catch(null),
  subscriptionId: lenientTextSchema,
  eventType: z.string().min(1),
  resource: z.unknown().optional(),
  resourceContainers: z
    .looseObject({
      project: z.looseObject({ id: lenientTextSchema }).nullish().catch(null),
    })
    .nullish()
    .catch(null),
  createdDate: lenientTextSchema,
});
export type AdoServiceHookEnvelope = z.infer<
  typeof adoServiceHookEnvelopeSchema
>;

export const adoConnectionDataSchema = z.looseObject({
  authenticatedUser: z.looseObject({
    id: z.string().min(1),
    providerDisplayName: z.string().nullish(),
    customDisplayName: z.string().nullish(),
    subjectDescriptor: z.string().nullish(),
    properties: z
      .looseObject({
        Account: z.looseObject({ $value: z.string().nullish() }).nullish(),
      })
      .nullish(),
  }),
});
export type AdoConnectionData = z.infer<typeof adoConnectionDataSchema>;

export const adoWiqlResultSchema = z.looseObject({
  workItems: z
    .array(z.looseObject({ id: z.number().int().positive() }))
    .nullish(),
});

/** `GET _apis/wit/workitems?ids=...&errorPolicy=omit`: unreadable items come back as null. */
export const adoWorkItemBatchSchema = z.looseObject({
  value: z.array(adoWorkItemSchema.nullable()),
});

export const adoWorkItemUpdatesSchema = z.looseObject({
  value: z.array(adoWorkItemUpdateSchema),
});

export const adoCommentSchema = z.looseObject({
  id: z.number().int(),
  text: z.string().nullish(),
  renderedText: z.string().nullish(),
  /** "markdown" | "html" (some versions serialize the enum as 0 | 1). */
  format: z.union([z.string(), z.number()]).nullish(),
  createdBy: z.unknown().optional(),
  createdDate: z.string().nullish(),
  isDeleted: z.boolean().nullish(),
});
export type AdoComment = z.infer<typeof adoCommentSchema>;

export const adoCommentListSchema = z.looseObject({
  comments: z.array(adoCommentSchema).nullish(),
});

export const adoCreatedCommentSchema = z.looseObject({
  id: z.number().int(),
});

export const adoErrorBodySchema = z.looseObject({
  message: z.string(),
});

const optionalTextSchema = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value?.trim() || null);

const optionalNumberOrTextSchema = z
  .union([z.number(), z.string()])
  .nullish()
  .catch(null)
  .transform((value) => {
    const text =
      value === null || value === undefined ? "" : String(value).trim();
    return text || null;
  });

/**
 * Typed view of the work item fields the provider reads. Every field falls
 * back to null when missing or of an unexpected type, so parsing a field map
 * never fails.
 */
export const adoWorkItemFieldsSchema = z.object({
  [AdoField.Title]: optionalTextSchema,
  [AdoField.TeamProject]: optionalTextSchema,
  [AdoField.WorkItemType]: optionalTextSchema,
  [AdoField.AreaPath]: optionalTextSchema,
  [AdoField.State]: optionalTextSchema,
  [AdoField.Tags]: optionalTextSchema,
  [AdoField.ChangedDate]: optionalTextSchema,
  [AdoField.CreatedDate]: optionalTextSchema,
  [AdoField.Description]: optionalTextSchema,
  [AdoField.History]: optionalTextSchema,
  [AdoField.AcceptanceCriteria]: optionalTextSchema,
  [AdoField.ReproSteps]: optionalTextSchema,
  [AdoField.SystemInfo]: optionalTextSchema,
  [AdoField.Priority]: optionalNumberOrTextSchema,
  [AdoField.AssignedTo]: z.unknown().optional(),
  [AdoField.CreatedBy]: z.unknown().optional(),
  [AdoField.ChangedBy]: z.unknown().optional(),
});
export type AdoWorkItemFields = z.infer<typeof adoWorkItemFieldsSchema>;

export function readWorkItemFields(
  fields: Record<string, unknown> | null | undefined
): AdoWorkItemFields {
  const parsed = adoWorkItemFieldsSchema.safeParse(fields ?? {});
  return parsed.success ? parsed.data : adoWorkItemFieldsSchema.parse({});
}

/**
 * Normalizes an organization URL to `https://dev.azure.com/{org}` or
 * `https://{org}.visualstudio.com` (no trailing slash). `http(s)://localhost`
 * URLs are kept with their path so tests can point at a local stub.
 * Returns null for anything else.
 */
export function normalizeOrganizationUrl(raw: string): string | null {
  const url = parseUrl(raw.trim());
  if (!url) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (LOCAL_HOSTS.has(host)) {
    return isHttpProtocol(url.protocol)
      ? `${url.protocol}//${url.host}${segments.map((segment) => `/${segment}`).join("")}`
      : null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (host === DEV_AZURE_HOST) {
    return segments[0] ? `https://${DEV_AZURE_HOST}/${segments[0]}` : null;
  }
  if (VISUAL_STUDIO_HOST_RE.test(host)) {
    return `https://${host}`;
  }
  return null;
}

/** Organization name of a normalized organization URL (for display and account details). */
export function organizationNameFromUrl(organizationUrl: string): string {
  const url = parseUrl(organizationUrl);
  if (!url) {
    return organizationUrl;
  }
  const host = url.hostname.toLowerCase();
  if (VISUAL_STUDIO_HOST_RE.test(host)) {
    return host.slice(0, host.indexOf("."));
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  return last ?? host;
}

/** True when `url` points inside the organization (same origin and organization path). */
export function urlBelongsToOrganization(
  url: string | URL,
  organizationUrl: string
): boolean {
  const parsed = typeof url === "string" ? parseUrl(url) : url;
  if (!parsed) {
    return false;
  }
  const base = organizationUrl.toLowerCase();
  const target = `${parsed.origin}${parsed.pathname}`.toLowerCase();
  return target === base || target.startsWith(`${base}/`);
}

/** A Git repository (REST 7.1 GitRepository). */
export const adoGitRepositorySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** "refs/heads/main"; absent on an empty repository. */
  defaultBranch: z.string().nullish(),
  remoteUrl: z.string().nullish(),
  webUrl: z.string().nullish(),
  isDisabled: z.boolean().nullish(),
  project: z.looseObject({
    id: z.string(),
    name: z.string().min(1),
    /** "private" or "public". */
    visibility: z.string().nullish(),
  }),
});
export type AdoGitRepository = z.infer<typeof adoGitRepositorySchema>;

export const adoGitRepositoryListSchema = z.looseObject({
  value: z.array(z.unknown()),
});

export const adoPullRequestSchema = z.looseObject({
  pullRequestId: z.number().int().positive(),
});

export const adoPullRequestListSchema = z.looseObject({
  value: z.array(adoPullRequestSchema),
});

/** A pipeline run (REST 7.1 Pipelines - Run Pipeline). */
export const adoPipelineRunSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().nullish(),
  _links: z
    .looseObject({
      web: z.looseObject({ href: z.string() }).nullish(),
    })
    .nullish(),
});

/** Positive 32-bit work item id from its decimal string, or null. */
export function parseWorkItemId(value: string): number | null {
  if (!DIGITS_RE.test(value)) {
    return null;
  }
  const workItemId = Number.parseInt(value, 10);
  return workItemId > 0 && workItemId <= MAX_WORK_ITEM_ID ? workItemId : null;
}

/** Parses an absolute URL, returning null when invalid. */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const DEV_AZURE_HOST = "dev.azure.com";
const VISUAL_STUDIO_HOST_RE = /^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DIGITS_RE = /^\d+$/;
const MAX_WORK_ITEM_ID = 2_147_483_647;

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** GET …/pullrequests/{id}. */
export const adoPullRequestDetailSchema = z.looseObject({
  pullRequestId: z.number().int().positive(),
  /** active, completed or abandoned. */
  status: z.string().nullish(),
  title: z.string().nullish(),
});

const adoThreadCommentSchema = z.looseObject({
  id: z.number().int(),
  parentCommentId: z.number().int().nullish(),
  author: z
    .looseObject({
      id: z.string().nullish(),
      displayName: z.string().nullish(),
    })
    .nullish(),
  content: z.string().nullish(),
  publishedDate: z.string().nullish(),
  /** text, system or codeChange. */
  commentType: z.string().nullish(),
  isDeleted: z.boolean().nullish(),
});

/** A thread of GET …/pullrequests/{id}/threads. */
export const adoThreadSchema = z.looseObject({
  id: z.number().int(),
  /** active, pending, fixed, wontFix, closed, byDesign or unknown. */
  status: z.string().nullish(),
  isDeleted: z.boolean().nullish(),
  threadContext: z
    .looseObject({
      filePath: z.string().nullish(),
      rightFileStart: z.looseObject({ line: z.number().int() }).nullish(),
      leftFileStart: z.looseObject({ line: z.number().int() }).nullish(),
    })
    .nullish(),
  comments: z.array(adoThreadCommentSchema).nullish(),
});
export type AdoThread = z.infer<typeof adoThreadSchema>;

export const adoThreadListSchema = z.looseObject({
  value: z.array(z.unknown()),
});

export const adoCreatedThreadCommentSchema = z.looseObject({
  id: z.number().int(),
});
