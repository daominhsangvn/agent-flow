"use client";

import { jwtClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { decodeJwt } from "jose";
import { useEffect, useSyncExternalStore } from "react";
import type { SessionClaims } from "./types";

/**
 * Browser access to the Better Auth endpoints, which the web app serves at
 * `/api/auth/*` (rewritten to apps/api).
 *
 * The session itself lives in an httpOnly cookie. Components read identity
 * from the short-lived JWT minted by `/api/auth/token`, kept in a module-level
 * store: it carries the user and active-organization claims and is the bearer
 * token for apps/api, so one request serves both.
 */

const AUTH_BASE_PATH = "/api/auth";
/** Refresh the JWT this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

const authClient = createAuthClient({
  baseURL: resolveBaseUrl(),
  basePath: AUTH_BASE_PATH,
  plugins: [organizationClient(), jwtClient()],
});

export type AuthError = { message?: string } | null;
export type AuthResult<T = unknown> = { data: T | null; error: AuthError };

export type AuthRoleName = "owner" | "admin" | "member";

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string | null;
  logo?: string | null;
};

export type FullOrganization = {
  id: string;
  name: string;
  members: Array<{
    id: string;
    role: string;
    user: { id: string; name: string; email: string };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string | null;
    status: string;
  }>;
};

/**
 * The Better Auth operations the UI uses, with declared result types (the
 * client's inferred types are not portable across package boundaries).
 */
export const authApi = {
  signInEmail: (input: {
    email: string;
    password: string;
  }): Promise<AuthResult> => authClient.signIn.email(input),
  signUpEmail: (input: {
    name: string;
    email: string;
    password: string;
  }): Promise<AuthResult> => authClient.signUp.email(input),
  requestPasswordReset: (input: {
    email: string;
    redirectTo: string;
  }): Promise<AuthResult> => authClient.requestPasswordReset(input),
  resetPassword: (input: {
    newPassword: string;
    token: string;
  }): Promise<AuthResult> => authClient.resetPassword(input),
  updateUser: (input: { name: string }): Promise<AuthResult> =>
    authClient.updateUser(input),
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions: boolean;
  }): Promise<AuthResult> => authClient.changePassword(input),
  createOrganization: (input: {
    name: string;
    slug: string;
  }): Promise<AuthResult<{ id: string }>> =>
    authClient.organization.create(input),
  getFullOrganization: (): Promise<AuthResult<FullOrganization>> =>
    authClient.organization.getFullOrganization() as Promise<
      AuthResult<FullOrganization>
    >,
  updateOrganization: (input: { name: string }): Promise<AuthResult> =>
    authClient.organization.update({ data: input }),
  inviteMember: (input: {
    email: string;
    role: AuthRoleName;
  }): Promise<AuthResult> => authClient.organization.inviteMember(input),
  updateMemberRole: (input: {
    memberId: string;
    role: AuthRoleName;
  }): Promise<AuthResult> => authClient.organization.updateMemberRole(input),
  removeMember: (memberId: string): Promise<AuthResult> =>
    authClient.organization.removeMember({ memberIdOrEmail: memberId }),
  cancelInvitation: (invitationId: string): Promise<AuthResult> =>
    authClient.organization.cancelInvitation({ invitationId }),
};

/** Organizations the signed-in user belongs to. */
export function useOrganizationSummaries(): {
  data: OrganizationSummary[] | null;
  isPending: boolean;
} {
  const { data, isPending } = authClient.useListOrganizations();
  return {
    data: data
      ? data.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug ?? null,
          logo: org.logo ?? null,
        }))
      : null,
    isPending,
  };
}

export type SessionStatus = "loading" | "signed-in" | "signed-out";

export type SessionSnapshot = {
  status: SessionStatus;
  token: string | null;
  claims: SessionClaims | null;
};

const LOADING: SessionSnapshot = {
  status: "loading",
  token: null,
  claims: null,
};
const SIGNED_OUT: SessionSnapshot = {
  status: "signed-out",
  token: null,
  claims: null,
};

let snapshot: SessionSnapshot = LOADING;
let inFlight: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

/** Re-mint the JWT (after sign-in, org switch, profile or slug changes). */
export function refreshSession(): Promise<string | null> {
  inFlight ??= mintToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** A JWT valid for at least a minute, or null when signed out. */
export function getSessionToken(): Promise<string | null> {
  const { token, claims } = snapshot;
  if (
    token &&
    claims?.exp &&
    claims.exp * 1000 - Date.now() > REFRESH_MARGIN_MS
  ) {
    return Promise.resolve(token);
  }
  return refreshSession();
}

const SIGN_IN_PATH = "/sign-in";

type SignOutOptions = { redirectUrl?: string };

export async function signOut(options?: SignOutOptions): Promise<void> {
  await authClient.signOut();
  publish(SIGNED_OUT);
  globalThis.location?.assign(options?.redirectUrl ?? SIGN_IN_PATH);
}

/** Switch the session's active organization and re-mint the JWT. */
export async function setActive(params: {
  organization: string | null;
}): Promise<void> {
  const result = await authClient.organization.setActive({
    organizationId: params.organization,
  });
  if (result.error) {
    throw new Error(result.error.message ?? "Could not switch organization");
  }
  await refreshSession();
}

export function useSessionSnapshot(): SessionSnapshot {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (snapshot.status === "loading") {
      refreshSession().catch(() => undefined);
    }
  }, []);
  return value;
}

async function mintToken(): Promise<string | null> {
  try {
    const result = await authClient.token();
    const token = result.data?.token ?? null;
    if (!token) {
      publish(SIGNED_OUT);
      return null;
    }
    publish({
      status: "signed-in",
      token,
      claims: decodeJwt(token) as SessionClaims,
    });
    return token;
  } catch {
    publish(SIGNED_OUT);
    return null;
  }
}

function publish(next: SessionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SessionSnapshot {
  return snapshot;
}

function getServerSnapshot(): SessionSnapshot {
  return LOADING;
}

function resolveBaseUrl(): string {
  if (globalThis.window !== undefined) {
    return globalThis.window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}
