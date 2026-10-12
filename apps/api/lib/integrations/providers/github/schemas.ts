import { z } from "zod";

/**
 * Zod schemas for the connection config and for the GitHub REST payloads the
 * provider reads. Payload schemas are loose: only the properties the provider
 * uses are declared.
 */

export const GITHUB_DEFAULT_API_URL = "https://api.github.com";
export const API_URL_HINT =
  "Use https://api.github.com, or https://{host}/api/v3 for GitHub Enterprise Server";

export const githubConnectionConfigSchema = z.object({
  apiUrl: z
    .string()
    .trim()
    .default(GITHUB_DEFAULT_API_URL)
    .transform((value) => value || GITHUB_DEFAULT_API_URL)
    .refine((value) => normalizeApiUrl(value) !== null, {
      message: API_URL_HINT,
    })
    .transform((value) => normalizeApiUrl(value) ?? value),
});
export type GitHubConnectionConfig = z.infer<
  typeof githubConnectionConfigSchema
>;

export const githubSecretsSchema = z.object({
  token: z.string().trim().min(1, "Enter the personal access token"),
});
export type GitHubSecrets = z.infer<typeof githubSecretsSchema>;

export const githubUserSchema = z.looseObject({
  id: z.number().int(),
  login: z.string().min(1),
  name: z.string().nullish(),
});
export type GitHubUser = z.infer<typeof githubUserSchema>;

export const githubRepositorySchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  owner: z.looseObject({ login: z.string().min(1) }),
  private: z.boolean(),
  html_url: z.string(),
  clone_url: z.string(),
  default_branch: z.string().nullish(),
  archived: z.boolean().nullish(),
  disabled: z.boolean().nullish(),
});
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;

/** One page of a repository listing; entries are parsed one by one. */
export const githubRepositoryPageSchema = z.array(z.unknown());

export const githubPullRequestSchema = z.looseObject({
  id: z.number().int(),
  number: z.number().int().positive(),
  html_url: z.string(),
});
export type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>;

export const githubPullRequestListSchema = z.array(githubPullRequestSchema);

export const githubErrorBodySchema = z.looseObject({
  message: z.string(),
  errors: z
    .array(
      z.looseObject({
        message: z.string().nullish(),
        code: z.string().nullish(),
      })
    )
    .nullish()
    .catch(null),
});

/**
 * https://api.github.com or a GitHub Enterprise Server API root, without a
 * trailing slash. Plain HTTP only for local hosts (tests). Null when invalid.
 */
export function normalizeApiUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(TRAILING_SLASHES_RE, "");
  return `${url.protocol}//${url.host}${path}`;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TRAILING_SLASHES_RE = /\/+$/;
