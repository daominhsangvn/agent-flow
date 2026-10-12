import "server-only";
import { redirect } from "next/navigation";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_ID,
} from "./auth-mode";
import type { AuthObject } from "./server-auth-object";
import {
  type AuthUser,
  authStateFromClaims,
  hasAccess,
  type SessionClaims,
  userFromClaims,
} from "./types";

/**
 * FEA-4334: builders for the synthetic `local_trusted` session. These are only
 * ever returned once {@link isLocalTrustedAuthActive} has confirmed the hard
 * non-production guard passed (see `auth-mode.ts`); nothing here re-checks the
 * environment, so callers MUST gate on that first.
 */

// A far-future expiry so the synthetic claims never read as "expired"; the
// values are inert (no signature is ever verified for this session).
const SYNTHETIC_ISSUED_AT_SECONDS = 0;
const SYNTHETIC_EXPIRY_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

const LOCAL_TRUSTED_CLAIMS: SessionClaims = {
  sub: LOCAL_TRUSTED_USER_ID,
  email: LOCAL_TRUSTED_USER_EMAIL,
  name: "E2E Local Trusted",
  image: null,
  org_id: LOCAL_TRUSTED_ORG_ID,
  org_slug: LOCAL_TRUSTED_ORG_SLUG,
  org_name: "Local Trusted",
  org_role: LOCAL_TRUSTED_ORG_ROLE,
  exp: SYNTHETIC_EXPIRY_SECONDS,
  iat: SYNTHETIC_ISSUED_AT_SECONDS,
  iss: "https://local-trusted.e2e.test",
};

/**
 * The synthetic signed-in `auth()` object: a fixed user in a fixed active org.
 * `getToken` returns null (no downstream API call is expected in the visual
 * container) and `has` reports the synthetic org-admin role.
 */
export function buildLocalTrustedAuth(): AuthObject {
  return {
    ...authStateFromClaims(LOCAL_TRUSTED_CLAIMS),
    sessionId: LOCAL_TRUSTED_SESSION_ID,
    getToken: () => Promise.resolve(null),
    has: (params) => hasAccess(LOCAL_TRUSTED_ORG_ROLE, params),
    redirectToSignIn: () => redirect("/sign-in"),
    redirectToSignUp: () => redirect("/sign-up"),
  };
}

/** The synthetic `currentUser()` result. */
export function buildLocalTrustedUser(): AuthUser {
  return userFromClaims(LOCAL_TRUSTED_CLAIMS);
}
