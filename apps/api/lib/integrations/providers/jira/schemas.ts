import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { jsonObjectSchema, stringRecordSchema } from "@/lib/json-schema";
import { isRecord } from "@/lib/type-guards";
import { JiraDeployment } from "./constants";
import { epochMillisToIso } from "./dates";

/**
 * Zod schemas for the connection config and for the Jira payloads the
 * provider reads (admin webhook and Automation bodies, REST v2/v3 issues,
 * changelogs, search results, comments, transitions, errors). Payload
 * schemas are loose: only the properties the provider uses are declared,
 * everything else passes through. In issues and webhook bodies only the
 * issue id and key (and `fields` being an object) are essential; every other
 * declared property falls back to null when it has an unexpected shape, so
 * one odd value never drops a whole delivery.
 */

export const SITE_URL_HINT =
  "Enter the Jira site URL, e.g. https://your-company.atlassian.net";
const SITE_URL_PROTOCOL_ERROR = "The Jira site URL must start with https://";
const SITE_URL_CREDENTIALS_ERROR =
  "Remove the user name and password from the Jira site URL";
const EMAIL_REQUIRED_ERROR =
  "Enter the email address of the Jira Cloud bot account";
const EMAIL_INVALID_ERROR = "Enter a valid email address";

/** Plain http is accepted only for a local Jira (tests, development). */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const connectionInputSchema = z.object({
  deployment: z.enum(JiraDeployment).default(JiraDeployment.Cloud),
  siteUrl: z.string().trim().min(1, SITE_URL_HINT).max(2048),
  email: z.string().trim().max(320).nullish(),
});
type ConnectionInput = z.infer<typeof connectionInputSchema>;

/**
 * Normalizes the site URL (Cloud: origin only; Data Center: origin plus
 * context path, no trailing slash) and drops the email on Data Center, where
 * the personal access token alone authenticates.
 */
export const jiraConnectionConfigSchema = connectionInputSchema
  .superRefine(checkConnectionInput)
  .transform(normalizeConnectionInput);
export type JiraConnectionConfig = z.output<typeof jiraConnectionConfigSchema>;

export const jiraSecretsSchema = z.object({
  apiToken: z.string().trim().min(1, "Enter the API token").max(8192),
});
export type JiraSecrets = z.infer<typeof jiraSecretsSchema>;

const idSchema = z.union([z.string(), z.number()]).transform(String);

/** Optional text that degrades to null instead of failing the payload. */
const optionalTextSchema = z.string().nullish().catch(null);

/**
 * A Jira date: a string (`2026-10-04T10:15:30.123+0000`) in admin webhooks and
 * REST, epoch milliseconds in Automation "Issue data (Jira format)" bodies.
 * Numbers become ISO strings; anything else degrades to null.
 */
const jiraDateSchema = z
  .union([z.string(), z.number()])
  .transform(normalizeJiraDate)
  .nullish()
  .catch(null);

/** Change values are strings in practice; anything else degrades to null instead of failing the payload. */
const looseTextSchema = z
  .union([z.string(), z.number()])
  .transform(String)
  .nullish()
  .catch(null);

export const jiraUserSchema = z.looseObject({
  /** Cloud. */
  accountId: optionalTextSchema,
  /** Data Center user name and user key. */
  name: optionalTextSchema,
  key: optionalTextSchema,
  emailAddress: optionalTextSchema,
  displayName: optionalTextSchema,
  timeZone: optionalTextSchema,
  active: z.boolean().nullish().catch(null),
});
export type JiraUser = z.infer<typeof jiraUserSchema>;

/** A user field of an issue or change; a value that is not a user object degrades to null. */
const optionalUserSchema = jiraUserSchema.nullish().catch(null);

const jiraNamedValueSchema = z.looseObject({
  name: optionalTextSchema,
});
const optionalNamedValueSchema = jiraNamedValueSchema.nullish().catch(null);

export const jiraAttachmentSchema = z.looseObject({
  id: idSchema.nullish().catch(null),
  filename: optionalTextSchema,
  /** Download URL (needs the connection credentials). */
  content: optionalTextSchema,
  mimeType: optionalTextSchema,
  size: z.number().nullish().catch(null),
});
export type JiraAttachment = z.infer<typeof jiraAttachmentSchema>;

export const jiraIssueFieldsSchema = z.looseObject({
  summary: optionalTextSchema,
  /** ADF on Cloud REST v3, wiki markup (string) in webhooks and on REST v2. */
  description: z.unknown().optional(),
  issuetype: optionalNamedValueSchema,
  status: optionalNamedValueSchema,
  priority: optionalNamedValueSchema,
  labels: z.array(z.string()).nullish().catch(null),
  assignee: optionalUserSchema,
  reporter: optionalUserSchema,
  creator: optionalUserSchema,
  project: z
    .looseObject({ key: optionalTextSchema, name: optionalTextSchema })
    .nullish()
    .catch(null),
  attachment: z.array(jiraAttachmentSchema).nullish().catch(null),
  /** ISO string (epoch milliseconds in Automation bodies are converted). */
  created: jiraDateSchema,
  updated: jiraDateSchema,
});
export type JiraIssueFields = z.infer<typeof jiraIssueFieldsSchema>;

/**
 * One changelog item. Jira names two properties `fromString` / `toString`;
 * they are exposed as `fromText` / `toText` because reading an absent
 * `toString` would return Object.prototype.toString.
 */
export const jiraChangeItemSchema = z.preprocess(
  exposeChangeTexts,
  z.looseObject({
    field: optionalTextSchema,
    fieldId: optionalTextSchema,
    from: looseTextSchema,
    to: looseTextSchema,
    fromText: looseTextSchema,
    toText: looseTextSchema,
    /** Webhooks only (Cloud): account ids of user fields. */
    tmpFromAccountId: looseTextSchema,
    tmpToAccountId: looseTextSchema,
  })
);
export type JiraChangeItem = z.infer<typeof jiraChangeItemSchema>;

const jiraChangeItemsSchema = z
  .array(jiraChangeItemSchema)
  .nullish()
  .catch(null);

/** `changelog` of a jira:issue_updated webhook (no author / created). */
export const jiraWebhookChangelogSchema = z.looseObject({
  id: idSchema.nullish().catch(null),
  items: jiraChangeItemsSchema,
});

/** One entry of a REST changelog (`expand=changelog`). */
export const jiraHistorySchema = z.looseObject({
  id: idSchema,
  created: jiraDateSchema,
  author: optionalUserSchema,
  items: jiraChangeItemsSchema,
});
export type JiraHistory = z.infer<typeof jiraHistorySchema>;

/** Histories without an id are dropped one by one; a value that is not a list degrades to null. */
const jiraHistoriesSchema = z
  .array(jiraHistorySchema.nullable().catch(null))
  .transform((histories) => histories.filter((history) => history !== null))
  .nullish()
  .catch(null);

const optionalCountSchema = z.number().nullish().catch(null);

/** Cloud `GET /rest/api/3/issue/{id}/changelog` (oldest first, paginated). */
export const jiraChangelogPageSchema = z.looseObject({
  values: jiraHistoriesSchema,
  total: optionalCountSchema,
});

export const jiraIssueSchema = z.looseObject({
  id: idSchema,
  key: z.string().trim().min(1),
  fields: z.preprocess((value) => value ?? {}, jiraIssueFieldsSchema),
  /** `expand=renderedFields`: field id -> HTML (or an object for comments/worklogs). */
  renderedFields: jsonObjectSchema.nullish().catch(null),
  /** `expand=names`: field id -> display name. */
  names: stringRecordSchema.nullish().catch(null),
  changelog: z
    .looseObject({
      histories: jiraHistoriesSchema,
      total: optionalCountSchema,
    })
    .nullish()
    .catch(null),
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;

/** Only the discriminating properties; the full body is parsed per event type. */
export const jiraWebhookEnvelopeSchema = z.looseObject({
  webhookEvent: z.string().nullish(),
  issue: z.unknown().optional(),
});

/**
 * Admin webhook body (jira:issue_created / jira:issue_updated) and Jira
 * Automation "Work item data (Jira format)" body ({issue, user, timestamp},
 * no webhookEvent). Issues are in the REST v2 shape.
 */
export const jiraWebhookBodySchema = z.looseObject({
  webhookEvent: z.string().nullish(),
  timestamp: z.union([z.number(), z.string()]).nullish().catch(null),
  user: optionalUserSchema,
  issue: jiraIssueSchema,
  changelog: jiraWebhookChangelogSchema.nullish().catch(null),
  /** comment_created / comment_updated only. */
  comment: z
    .looseObject({
      id: idSchema,
      author: optionalUserSchema,
      updateAuthor: optionalUserSchema,
      /** Wiki markup in webhooks; ADF when a v3 shape is sent. */
      body: z.unknown().optional(),
    })
    .nullish()
    .catch(null),
});
export type JiraWebhookBody = z.infer<typeof jiraWebhookBodySchema>;

/**
 * Cloud `GET /rest/api/3/search/jql` (nextPageToken / isLast) and Data
 * Center `GET /rest/api/2/search` (startAt / total) share this schema.
 */
export const jiraSearchResultSchema = z.looseObject({
  issues: z.array(jiraIssueSchema).nullish(),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
  startAt: z.number().nullish(),
  total: z.number().nullish(),
});
export type JiraSearchResult = z.infer<typeof jiraSearchResultSchema>;

export const jiraCommentSchema = z.looseObject({
  id: idSchema,
  author: optionalUserSchema,
  created: jiraDateSchema,
  /** ADF on Cloud v3, wiki markup on v2. */
  body: z.unknown().optional(),
  /** `expand=renderedBody`: HTML. */
  renderedBody: z.string().nullish(),
});
export type JiraComment = z.infer<typeof jiraCommentSchema>;

export const jiraCommentPageSchema = z.looseObject({
  comments: z.array(jiraCommentSchema).nullish(),
});

export const jiraCreatedCommentSchema = z.looseObject({
  id: idSchema,
});

export const jiraTransitionSchema = z.looseObject({
  id: idSchema,
  name: z.string().nullish(),
  to: jiraNamedValueSchema.nullish(),
});
export type JiraTransition = z.infer<typeof jiraTransitionSchema>;

export const jiraTransitionsSchema = z.looseObject({
  transitions: z.array(jiraTransitionSchema).nullish(),
});

export const jiraErrorBodySchema = z.looseObject({
  errorMessages: z.array(z.string()).nullish(),
  errors: stringRecordSchema.nullish(),
  message: z.string().nullish(),
});

export const jiraPollCursorSchema = z.object({
  since: z.iso.datetime({ offset: true }),
});
export type JiraPollCursor = z.infer<typeof jiraPollCursorSchema>;

/**
 * Cloud sites live at the origin; Data Center may sit under a context path
 * (https://host/jira). Query and fragment are dropped.
 */
export function normalizeSiteUrl(
  value: string,
  deployment: JiraDeployment
): Result<string, string> {
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) {
    return Result.err(SITE_URL_HINT);
  }
  const url = new URL(trimmed);
  if (!isAllowedSiteProtocol(url)) {
    return Result.err(SITE_URL_PROTOCOL_ERROR);
  }
  if (url.username || url.password) {
    return Result.err(SITE_URL_CREDENTIALS_ERROR);
  }
  if (deployment === JiraDeployment.Cloud) {
    return Result.ok(url.origin);
  }
  return Result.ok(`${url.origin}${trimTrailingSlashes(url.pathname)}`);
}

function checkConnectionInput(
  input: ConnectionInput,
  context: z.RefinementCtx
): void {
  const site = normalizeSiteUrl(input.siteUrl, input.deployment);
  if (!site.ok) {
    context.addIssue({
      code: "custom",
      path: ["siteUrl"],
      message: site.error,
    });
  }
  if (input.deployment !== JiraDeployment.Cloud) {
    return;
  }
  if (!input.email) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: EMAIL_REQUIRED_ERROR,
    });
  } else if (!z.email().safeParse(input.email).success) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: EMAIL_INVALID_ERROR,
    });
  }
}

function normalizeConnectionInput(input: ConnectionInput): {
  deployment: JiraDeployment;
  siteUrl: string;
  email: string | null;
} {
  const site = normalizeSiteUrl(input.siteUrl, input.deployment);
  return {
    deployment: input.deployment,
    siteUrl: site.ok ? site.value : input.siteUrl,
    email:
      input.deployment === JiraDeployment.Cloud ? (input.email ?? null) : null,
  };
}

function isAllowedSiteProtocol(url: URL): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function exposeChangeTexts(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    fromText: readOwnProperty(value, "fromString"),
    toText: readOwnProperty(value, "toString"),
  };
}

function readOwnProperty(
  record: Record<string, unknown>,
  key: string
): unknown {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.value ?? null;
}

function normalizeJiraDate(value: string | number): string | null {
  return typeof value === "number" ? epochMillisToIso(value) : value;
}
