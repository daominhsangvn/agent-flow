import { z } from "zod";

/**
 * Zod schemas for the connection config and for the Bitbucket Cloud REST 2.0
 * payloads the provider reads. Payload schemas are loose: only the properties
 * the provider uses are declared.
 */

export const BITBUCKET_DEFAULT_API_URL = "https://api.bitbucket.org/2.0";
export const API_URL_HINT =
  "Bitbucket Cloud only: the API URL is https://api.bitbucket.org/2.0";
/** Workspace ID as Bitbucket shows it in URLs (bitbucket.org/{workspace}). */
const WORKSPACE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const WORKSPACE_HINT =
  "Enter the workspace ID as it appears in bitbucket.org/{workspace}";

export const bitbucketConnectionConfigSchema = z.object({
  /** Not on the form: Bitbucket Cloud's API, or a local fake in tests. */
  apiUrl: z
    .string()
    .trim()
    .default(BITBUCKET_DEFAULT_API_URL)
    .transform((value) => value || BITBUCKET_DEFAULT_API_URL)
    .refine((value) => normalizeApiUrl(value) !== null, {
      message: API_URL_HINT,
    })
    .transform((value) => normalizeApiUrl(value) ?? value),
  /** Empty: every workspace the token's account belongs to. */
  workspace: z
    .string()
    .trim()
    .default("")
    .refine((value) => value === "" || WORKSPACE_SLUG_RE.test(value), {
      message: WORKSPACE_HINT,
    }),
});
export type BitbucketConnectionConfig = z.infer<
  typeof bitbucketConnectionConfigSchema
>;

export const bitbucketSecretsSchema = z.object({
  token: z.string().trim().min(1, "Enter the API token"),
});
export type BitbucketSecrets = z.infer<typeof bitbucketSecretsSchema>;

export const bitbucketUserSchema = z.looseObject({
  uuid: z.string().min(1),
  display_name: z.string().nullish(),
  nickname: z.string().nullish(),
  username: z.string().nullish(),
});
export type BitbucketUser = z.infer<typeof bitbucketUserSchema>;

const hrefSchema = z.looseObject({ href: z.string() });

export const bitbucketRepositorySchema = z.looseObject({
  uuid: z.string().min(1),
  /** `{workspace}/{repo_slug}`. */
  full_name: z.string().min(3),
  slug: z.string().min(1),
  is_private: z.boolean().nullish(),
  workspace: z.looseObject({
    uuid: z.string().min(1),
    slug: z.string().min(1),
  }),
  mainbranch: z.looseObject({ name: z.string().min(1) }).nullish(),
  links: z.looseObject({
    html: hrefSchema,
    clone: z
      .array(z.looseObject({ name: z.string(), href: z.string() }))
      .nullish(),
  }),
});
export type BitbucketRepository = z.infer<typeof bitbucketRepositorySchema>;

/** A page of a paginated collection; entries are parsed one by one. */
export const bitbucketPageSchema = z.looseObject({
  values: z.array(z.unknown()),
  next: z.string().nullish(),
});
export type BitbucketPage = z.infer<typeof bitbucketPageSchema>;

/** An entry of GET /user/workspaces. */
export const bitbucketWorkspaceAccessSchema = z.looseObject({
  workspace: z.looseObject({ slug: z.string().min(1) }),
});

export const bitbucketPullRequestSchema = z.looseObject({
  id: z.number().int().positive(),
  links: z.looseObject({ html: hrefSchema }),
});
export type BitbucketPullRequest = z.infer<typeof bitbucketPullRequestSchema>;

export const bitbucketErrorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string().nullish(),
    detail: z.unknown().optional(),
  }),
});

/**
 * Bitbucket Cloud's API root, without a trailing slash. Any other https host
 * is refused (the connection's token is sent there); plain HTTP only for
 * local hosts (tests). Null when invalid.
 */
export function normalizeApiUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  const cloud =
    url.protocol === "https:" && url.hostname.toLowerCase() === CLOUD_API_HOST;
  if (!(cloud || (local && url.protocol === "http:"))) {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${url.protocol}//${url.host}${path}`;
}

const CLOUD_API_HOST = "api.bitbucket.org";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TRAILING_SLASHES_RE = /\/+$/;
