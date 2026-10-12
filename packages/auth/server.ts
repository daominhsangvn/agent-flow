import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isLocalTrustedAuthActive } from "./auth-mode";
import {
  buildLocalTrustedAuth,
  buildLocalTrustedUser,
} from "./local-trusted-session";
import type { AuthObject } from "./server-auth-object";
import { resolveSessionClaims, verifySessionToken } from "./session-token";
import {
  type AuthUser,
  authStateFromClaims,
  hasAccess,
  type SessionClaims,
  userFromClaims,
} from "./types";

export type { AuthObject, MiddlewareAuth } from "./server-auth-object";
export type { AuthUser, SessionClaims } from "./types";

const SIGN_IN_PATH = "/sign-in";
const SIGN_UP_PATH = "/sign-up";

/**
 * The caller's identity in a server component, server action or route handler.
 *
 * Resolution: an `Authorization: Bearer <session JWT>` header (calls from the
 * web app to apps/api), otherwise the browser's session cookie exchanged for a
 * JWT at apps/api. Memoized per request.
 *
 * Under `AUTH_MODE=local_trusted` (non-production e2e only, see auth-mode.ts) a
 * fixed synthetic identity is returned instead.
 */
export const auth = cache(async (): Promise<AuthObject> => {
  if (isLocalTrustedAuthActive()) {
    return buildLocalTrustedAuth();
  }
  const requestHeaders = await headers();
  const resolved = await resolveSessionClaims({
    authorization: requestHeaders.get("authorization"),
    cookie: requestHeaders.get("cookie"),
  });
  return buildAuthObject(resolved?.claims ?? null, resolved?.token ?? null);
});

/** The signed-in user, or null. Built from the session JWT claims. */
export async function currentUser(): Promise<AuthUser | null> {
  if (isLocalTrustedAuthActive()) {
    return buildLocalTrustedUser();
  }
  const { sessionClaims } = await auth();
  return sessionClaims ? userFromClaims(sessionClaims) : null;
}

/**
 * Verify a session JWT presented by a client. Throws when it is not a valid,
 * unexpired token from this deployment's identity provider.
 */
export async function verifyToken(token: string): Promise<SessionClaims> {
  const claims = await verifySessionToken(token);
  if (!claims) {
    throw new Error("Invalid session token");
  }
  return claims;
}

export function buildAuthObject(
  claims: SessionClaims | null,
  token: string | null
): AuthObject {
  const state = authStateFromClaims(claims);
  return {
    ...state,
    getToken: () => Promise.resolve(token),
    has: (params) => hasAccess(state.orgRole, params),
    redirectToSignIn: (options) =>
      redirect(withReturnUrl(SIGN_IN_PATH, options?.returnBackUrl)),
    redirectToSignUp: (options) =>
      redirect(withReturnUrl(SIGN_UP_PATH, options?.returnBackUrl)),
  };
}

function withReturnUrl(path: string, returnBackUrl?: string): string {
  return returnBackUrl
    ? `${path}?redirect_url=${encodeURIComponent(returnBackUrl)}`
    : path;
}
