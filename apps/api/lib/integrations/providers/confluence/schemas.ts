import { z } from "zod";
import { ATLASSIAN_CLOUD_ID_RE } from "../atlassian/auth";

/**
 * Zod schemas for the Confluence Cloud connection and for the REST payloads
 * the provider reads (v2 pages, spaces and comments; v1 current user and
 * CQL search). Payload schemas are loose: only the properties used are
 * declared.
 */

const SITE_URL_HINT =
  "Enter the Confluence site URL, e.g. https://your-company.atlassian.net";
/** Plain http is accepted only for a local server (tests, development). */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The site's origin: `https://acme.atlassian.net/wiki/...` keeps `https://acme.atlassian.net`. */
const siteUrlSchema = z
  .string()
  .trim()
  .min(1, SITE_URL_HINT)
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: SITE_URL_HINT });
      return z.NEVER;
    }
    const local = LOCAL_HOSTNAMES.has(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      context.addIssue({
        code: "custom",
        message: "The Confluence site URL must start with https://",
      });
      return z.NEVER;
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Remove the user name and password from the site URL",
      });
      return z.NEVER;
    }
    return url.origin;
  });

export const confluenceConnectionConfigSchema = z.object({
  siteUrl: siteUrlSchema,
  email: z
    .string()
    .trim()
    .min(1, "Enter the email address of the bot account")
    .max(320)
    .pipe(z.email("Enter a valid email address")),
  /**
   * Not on the form: set by validation when the token only works through
   * the Atlassian API gateway (an API token with scopes).
   */
  cloudId: z.string().trim().regex(ATLASSIAN_CLOUD_ID_RE).nullish(),
});
export type ConfluenceConnectionConfig = z.output<
  typeof confluenceConnectionConfigSchema
>;

export const confluenceSecretsSchema = z.object({
  apiToken: z.string().trim().min(1, "Enter the API token").max(8192),
});
export type ConfluenceSecrets = z.infer<typeof confluenceSecretsSchema>;

/** `GET /wiki/rest/api/user/current`. */
export const confluenceCurrentUserSchema = z.looseObject({
  /** "known" for an account; "anonymous" without credentials. */
  type: z.string().nullish(),
  accountId: z.string().nullish(),
  displayName: z.string().nullish(),
  email: z.string().nullish(),
});

const versionSchema = z.looseObject({
  number: z.number().int(),
  authorId: z.string().nullish(),
  createdAt: z.string().nullish(),
});

const bodySchema = z
  .looseObject({
    storage: z.looseObject({ value: z.string().nullish() }).nullish(),
  })
  .nullish();

const linksSchema = z
  .looseObject({
    webui: z.string().nullish(),
    next: z.string().nullish(),
    base: z.string().nullish(),
  })
  .nullish();

/** `GET /wiki/api/v2/pages/{id}`. */
export const confluencePageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  spaceId: z.union([z.string(), z.number()]).transform(String),
  parentId: z.union([z.string(), z.number()]).transform(String).nullish(),
  status: z.string().nullish(),
  version: versionSchema,
  body: bodySchema,
  _links: linksSchema,
});
export type ConfluencePage = z.infer<typeof confluencePageSchema>;

/** A space of `GET /wiki/api/v2/spaces`. */
export const confluenceSpaceSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  key: z.string(),
  name: z.string().nullish(),
});
export type ConfluenceSpace = z.infer<typeof confluenceSpaceSchema>;

/** A footer or inline comment of the v2 API. */
export const confluenceCommentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  pageId: z.union([z.string(), z.number()]).transform(String).nullish(),
  parentCommentId: z
    .union([z.string(), z.number()])
    .transform(String)
    .nullish(),
  /** Inline comments: open, reopened, resolved or dangling. */
  resolutionStatus: z.string().nullish(),
  properties: z
    .looseObject({
      inlineOriginalSelection: z.string().nullish(),
    })
    .nullish(),
  version: versionSchema,
  body: bodySchema,
  _links: linksSchema,
});
export type ConfluenceComment = z.infer<typeof confluenceCommentSchema>;

/** A page of results of the v2 API. */
export const confluenceListSchema = z.looseObject({
  results: z.array(z.unknown()),
  _links: linksSchema,
});

/** `GET /wiki/rest/api/content/search` (CQL). */
export const confluenceSearchSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      id: z.union([z.string(), z.number()]).transform(String),
      type: z.string().nullish(),
      title: z.string(),
      space: z.looseObject({ key: z.string() }).nullish(),
      version: z.looseObject({ number: z.number().int() }).nullish(),
      _links: linksSchema,
    })
  ),
});

/** Created page or comment. */
export const confluenceCreatedSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  _links: linksSchema,
});

/** Confluence's error bodies (v1 `message`, v2 `errors[].title`). */
export const confluenceErrorBodySchema = z.looseObject({
  message: z.string().nullish(),
  errors: z
    .array(
      z.looseObject({
        title: z.string().nullish(),
        detail: z.string().nullish(),
      })
    )
    .nullish(),
});
