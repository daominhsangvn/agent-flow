import { z } from "zod";

/**
 * Zod schemas for the connection config and for the Gitea REST API (v1)
 * payloads the provider reads. Payload schemas are loose: only the properties
 * the provider uses are declared.
 */

export const LOCAL_GIT_DEFAULT_URL = "http://localhost:3300";
export const SERVER_URL_HINT =
  "Enter the address of Local Git, e.g. http://localhost:3300";
export const RUNNER_URL_HINT =
  "Enter how runners reach Local Git, e.g. http://host.docker.internal:3300, or leave it empty";
/** User or organization name as Gitea accepts it. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const OWNER_HINT =
  "Enter a user or organization name of Local Git (letters, digits, dots, dashes, underscores)";
const TRAILING_SLASHES_RE = /\/+$/;

export const localGitConnectionConfigSchema = z.object({
  /** Where the API reaches Local Git. */
  serverUrl: z
    .string()
    .trim()
    .default(LOCAL_GIT_DEFAULT_URL)
    .transform((value) => value || LOCAL_GIT_DEFAULT_URL)
    .refine((value) => normalizeBaseUrl(value) !== null, {
      message: SERVER_URL_HINT,
    })
    .transform((value) => normalizeBaseUrl(value) ?? value),
  /** Where runners clone from; empty: the server URL. */
  runnerUrl: z
    .string()
    .trim()
    .default("")
    .refine((value) => value === "" || normalizeBaseUrl(value) !== null, {
      message: RUNNER_URL_HINT,
    })
    .transform((value) => (value ? (normalizeBaseUrl(value) ?? value) : "")),
  /** Empty: every repository the token can access; new ones go to its account. */
  owner: z
    .string()
    .trim()
    .default("")
    .refine((value) => value === "" || OWNER_RE.test(value), {
      message: OWNER_HINT,
    }),
});
export type LocalGitConnectionConfig = z.infer<
  typeof localGitConnectionConfigSchema
>;

export const localGitSecretsSchema = z.object({
  token: z.string().trim().min(1, "Enter the access token"),
});
export type LocalGitSecrets = z.infer<typeof localGitSecretsSchema>;

export const localGitUserSchema = z.looseObject({
  id: z.number().int(),
  login: z.string().min(1),
  full_name: z.string().nullish(),
});
export type LocalGitUser = z.infer<typeof localGitUserSchema>;

export const localGitRepositorySchema = z.looseObject({
  id: z.number().int().positive(),
  /** `{owner}/{name}`. */
  full_name: z.string().min(3),
  name: z.string().min(1),
  private: z.boolean().nullish(),
  empty: z.boolean().nullish(),
  default_branch: z.string().nullish(),
  html_url: z.string().min(1),
  clone_url: z.string().min(1),
  owner: z.looseObject({ login: z.string().min(1) }),
});
export type LocalGitRepository = z.infer<typeof localGitRepositorySchema>;

/** GET /repos/search; entries are parsed one by one. */
export const localGitSearchSchema = z.looseObject({
  data: z.array(z.unknown()),
});

export const localGitPullRequestSchema = z.looseObject({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.string(),
});
export type LocalGitPullRequest = z.infer<typeof localGitPullRequestSchema>;

/** Gitea answers errors as `{ message }`. */
export const localGitErrorBodySchema = z.looseObject({
  message: z.string().nullish(),
});

/** Any JSON object, for calls whose answer only needs to succeed. */
export const anyObjectSchema = z.looseObject({});

/**
 * An http(s) base URL without trailing slashes, query, fragment or
 * credentials: Local Git runs on the user's own machines, so any host is
 * accepted. Null when invalid.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${url.protocol}//${url.host}${path}`;
}
