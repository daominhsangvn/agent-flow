import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import type { SessionClaims } from "./types";

/**
 * Server-side access to the Better Auth session in apps/api.
 *
 * - `fetchSessionToken` exchanges the browser's session cookie for a short-lived
 *   JWT (`GET /api/auth/token`).
 * - `verifySessionToken` checks a JWT against the API's JWKS
 *   (`GET /api/auth/jwks`, cached by jose) and the expected issuer/audience.
 *
 * Used by the `auth()` helper (server components, route handlers) and by the
 * middleware wrapper. Both apps/app and apps/api run them.
 */

const AUTH_BASE_PATH = "/api/auth";
/** Cookie names Better Auth uses with `cookiePrefix: "agentflow"`. */
const SESSION_COOKIE_NAMES = [
  "agentflow.session_token",
  "__Secure-agentflow.session_token",
];
const JWKS_TTL_MS = 10 * 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 5000;

type KeySet = ReturnType<typeof createLocalJWKSet>;
let cachedKeySet: { keySet: KeySet; fetchedAt: number } | null = null;

/** Base URL of apps/api as reachable from this server process. */
export function authApiUrl(): string {
  return (
    process.env.AUTH_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3002"
  );
}

/** Issuer and audience the API stamps on its tokens (the web app origin). */
export function expectedIssuer(): string {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) {
    return false;
  }
  return SESSION_COOKIE_NAMES.some((name) => cookieHeader.includes(`${name}=`));
}

/**
 * True when the value is shaped like a JWT signed by the session issuer
 * (EdDSA). API keys (`sk_live_*`) and desktop access tokens (their own `typ`)
 * are rejected without a network call.
 */
export function looksLikeSessionJwt(token: string): boolean {
  if (token.split(".").length !== 3) {
    return false;
  }
  try {
    const header = decodeProtectedHeader(token);
    return (
      header.alg === "EdDSA" &&
      (header.typ === undefined || header.typ === "JWT")
    );
  } catch {
    return false;
  }
}

/** Verified claims, or null when the token is invalid, expired or foreign. */
export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  if (!looksLikeSessionJwt(token)) {
    return null;
  }
  try {
    return await verifyWithKeySet(token, await loadKeySet(false));
  } catch (error) {
    // A key we have not seen yet means the API rotated its signing key.
    if (!(error instanceof errors.JWKSNoMatchingKey)) {
      return null;
    }
  }
  try {
    return await verifyWithKeySet(token, await loadKeySet(true));
  } catch {
    return null;
  }
}

async function verifyWithKeySet(
  token: string,
  keySet: KeySet
): Promise<SessionClaims | null> {
  const issuer = expectedIssuer();
  const { payload } = await jwtVerify(token, keySet, {
    issuer,
    audience: issuer,
  });
  return typeof payload.sub === "string" ? (payload as SessionClaims) : null;
}

/**
 * The API's public signing keys, fetched with the global `fetch` (works in
 * both Node and edge runtimes) and cached for {@link JWKS_TTL_MS}.
 */
async function loadKeySet(forceRefresh: boolean): Promise<KeySet> {
  if (
    !forceRefresh &&
    cachedKeySet &&
    Date.now() - cachedKeySet.fetchedAt < JWKS_TTL_MS
  ) {
    return cachedKeySet.keySet;
  }
  const response = await fetch(`${authApiUrl()}${AUTH_BASE_PATH}/jwks`, {
    cache: "no-store",
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`JWKS request failed with ${response.status}`);
  }
  const keySet = createLocalJWKSet((await response.json()) as JSONWebKeySet);
  cachedKeySet = { keySet, fetchedAt: Date.now() };
  return keySet;
}

/** Exchanges a session cookie for a JWT; null when there is no live session. */
export async function fetchSessionToken(
  cookieHeader: string | null
): Promise<string | null> {
  if (!hasSessionCookie(cookieHeader)) {
    return null;
  }
  try {
    const response = await fetch(`${authApiUrl()}${AUTH_BASE_PATH}/token`, {
      headers: { cookie: cookieHeader ?? "" },
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

/** Resolve a bearer token or a session cookie to verified claims. */
export async function resolveSessionClaims(input: {
  authorization: string | null;
  cookie: string | null;
}): Promise<{ claims: SessionClaims; token: string } | null> {
  const bearer = input.authorization?.startsWith("Bearer ")
    ? input.authorization.slice("Bearer ".length).trim()
    : null;
  if (bearer && looksLikeSessionJwt(bearer)) {
    const claims = await verifySessionToken(bearer);
    if (claims) {
      return { claims, token: bearer };
    }
  }
  const token = await fetchSessionToken(input.cookie);
  if (!token) {
    return null;
  }
  const claims = await verifySessionToken(token);
  return claims ? { claims, token } : null;
}
