import { createHash } from "node:crypto";
import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { HttpMethod, type ProviderHttp } from "../../types";

/**
 * App-only tokens of the bot's Microsoft Entra app registration (client
 * credentials grant against the bot's tenant: bots are single-tenant). One
 * token per scope: the Bot Connector (replies) and Microsoft Graph (reading
 * threads). Tokens are kept until shortly before they expire, keyed by a hash
 * of the secret so a rotated secret never reuses an old token.
 */

export const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export type BotCredentials = {
  appId: string;
  tenantId: string;
  clientSecret: string;
};

export type EntraTokenError = {
  message: string;
  retryable: boolean;
  status: number;
};

const TOKEN_TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const DESCRIPTION_MAX_LENGTH = 300;
const LINE_BREAK_RE = /[\r\n]+/;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

const tokenErrorSchema = z.object({
  error: z.string().max(100),
  error_description: z.string().optional(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function acquireEntraToken(
  http: ProviderHttp,
  credentials: BotCredentials,
  scope: string,
  now: Date
): Promise<Result<string, EntraTokenError>> {
  const key = cacheKey(credentials, scope);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now.getTime()) {
    return Result.ok(cached.token);
  }
  const response = await http.request({
    method: HttpMethod.Post,
    url: `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.appId,
      client_secret: credentials.clientSecret,
      scope,
      grant_type: "client_credentials",
    }).toString(),
    timeoutMs: TOKEN_TIMEOUT_MS,
  });
  const parsed = tokenResponseSchema.safeParse(response.json);
  if (response.ok && parsed.success) {
    remember(key, {
      token: parsed.data.access_token,
      expiresAt: now.getTime() + parsed.data.expires_in * 1000,
    });
    return Result.ok(parsed.data.access_token);
  }
  return Result.err({
    message: describeTokenFailure(response.status, response.json),
    retryable: response.retryable,
    status: response.status,
  });
}

/** Forgets cached tokens (tests). */
export function clearEntraTokenCache(): void {
  tokenCache.clear();
}

function describeTokenFailure(status: number, json: unknown): string {
  if (status === 0) {
    return "Could not reach Microsoft Entra ID to sign in the bot (network error or timeout).";
  }
  const error = tokenErrorSchema.safeParse(json);
  if (!error.success) {
    return `Microsoft Entra ID did not issue a token for the bot (HTTP ${status}).`;
  }
  // The first line carries the AADSTS code and its meaning; trace ids follow.
  const description =
    error.data.error_description?.split(LINE_BREAK_RE)[0]?.trim() ?? "";
  const detail = description
    ? `: ${description.slice(0, DESCRIPTION_MAX_LENGTH)}`
    : "";
  return `Microsoft Entra ID refused to sign in the bot (${error.data.error})${detail}. Check the App ID, the tenant ID and the client secret.`;
}

function cacheKey(credentials: BotCredentials, scope: string): string {
  const secret = createHash("sha256")
    .update(credentials.clientSecret, "utf8")
    .digest("hex");
  return [credentials.tenantId, credentials.appId, scope, secret].join("|");
}

function remember(key: string, entry: { token: string; expiresAt: number }) {
  if (tokenCache.size >= CACHE_MAX_ENTRIES && !tokenCache.has(key)) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) {
      tokenCache.delete(oldest);
    }
  }
  tokenCache.set(key, entry);
}
