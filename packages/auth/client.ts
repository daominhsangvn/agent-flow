"use client";

import { createElement, Fragment, type ReactNode, useEffect } from "react";
import {
  getSessionToken,
  refreshSession,
  setActive,
  signOut,
  useOrganizationSummaries,
  useSessionSnapshot,
} from "./auth-client";
import {
  type AuthOrganization,
  authStateFromClaims,
  type HasParams,
  hasAccess,
  organizationFromClaims,
  userFromClaims,
} from "./types";

/**
 * Client-side identity hooks and components, backed by Better Auth.
 *
 * Names and return shapes follow the Clerk hooks the app was written against
 * (`useAuth`, `useUser`, `useOrganization`, `useOrganizationList`, `useClerk`,
 * ...), so existing components keep working. `isLoaded` is false until the
 * first session JWT request settles; `user`/`organization` are `undefined`
 * while loading and `null` when absent.
 */

// biome-ignore lint/performance/noBarrelFile: package public API
export { setActive, signOut } from "./auth-client";
export { CreateOrganization } from "./components/create-organization";
export { OrganizationProfile } from "./components/organization-profile";
export { UserProfile } from "./components/user-profile";

export function useAuth() {
  const session = useSessionSnapshot();
  const state = authStateFromClaims(session.claims);
  const isLoaded = session.status !== "loading";
  return {
    ...state,
    isLoaded,
    isSignedIn: isLoaded ? session.status === "signed-in" : undefined,
    getToken: getSessionToken,
    has: (params: HasParams) => hasAccess(state.orgRole, params),
    signOut,
  };
}

export function useUser() {
  const session = useSessionSnapshot();
  if (session.status === "loading") {
    return { isLoaded: false, isSignedIn: undefined, user: undefined };
  }
  return {
    isLoaded: true,
    isSignedIn: session.status === "signed-in",
    user: session.claims
      ? { ...userFromClaims(session.claims), reload: refreshSession }
      : null,
  };
}

export function useOrganization() {
  const session = useSessionSnapshot();
  if (session.status === "loading") {
    return { isLoaded: false, organization: undefined, membership: undefined };
  }
  const organization = organizationFromClaims(session.claims);
  const role = session.claims?.org_role ?? null;
  return {
    isLoaded: true,
    organization: organization
      ? { ...organization, reload: refreshSession }
      : null,
    membership: role ? { role } : null,
  };
}

export type OrganizationMembership = {
  id: string;
  role?: string;
  organization: AuthOrganization;
};

/**
 * Organizations the user belongs to. The parameter is accepted for call-site
 * compatibility; the list is fetched in one page, so `hasNextPage` is false.
 */
export function useOrganizationList(_params?: unknown) {
  const { data, isPending } = useOrganizationSummaries();
  const memberships: OrganizationMembership[] = (data ?? []).map((org) => ({
    id: org.id,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: org.logo ?? "",
    },
  }));
  return {
    isLoaded: !isPending,
    setActive,
    userMemberships: {
      data: memberships,
      isLoading: isPending,
      hasNextPage: false,
      fetchNext: () => undefined,
    },
  };
}

export function useSession() {
  const session = useSessionSnapshot();
  const isLoaded = session.status !== "loading";
  return {
    isLoaded,
    isSignedIn: isLoaded ? session.status === "signed-in" : undefined,
    session: session.claims
      ? {
          id: session.claims.sub,
          reload: refreshSession,
          getToken: getSessionToken,
        }
      : null,
  };
}

/** Session-level actions (the Clerk instance shape). */
export function useClerk() {
  const session = useSessionSnapshot();
  return {
    loaded: session.status !== "loading",
    setActive,
    signOut,
  };
}

/**
 * Single sign-on is not configured in this deployment. `sso()` reports the
 * failure as a value, which callers already render as a manual fallback.
 */
export function useSignIn() {
  return {
    isLoaded: true,
    signIn: {
      sso: (_params?: unknown) =>
        Promise.resolve({
          error: new Error("Single sign-on is not configured"),
        }),
    },
  };
}

type ShowCondition =
  | "signed-in"
  | "signed-out"
  | ((has: (params: HasParams) => boolean) => boolean);

/** Render `children` when the condition holds, otherwise `fallback`. */
export function Show({
  when,
  fallback = null,
  children,
}: {
  when: ShowCondition;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const session = useSessionSnapshot();
  if (session.status === "loading") {
    return null;
  }
  const signedIn = session.status === "signed-in";
  const role = session.claims?.org_role ?? null;
  let visible: boolean;
  if (when === "signed-in") {
    visible = signedIn;
  } else if (when === "signed-out") {
    visible = !signedIn;
  } else {
    visible = signedIn && when((params) => hasAccess(role, params));
  }
  return createElement(Fragment, null, visible ? children : fallback);
}

/**
 * OAuth callbacks are completed server-side by Better Auth; this page only has
 * to send the browser on.
 */
export function AuthenticateWithRedirectCallback({
  signInFallbackRedirectUrl = "/",
}: {
  signInFallbackRedirectUrl?: string;
  [key: string]: unknown;
}) {
  useEffect(() => {
    globalThis.location?.replace(signInFallbackRedirectUrl);
  }, [signInFallbackRedirectUrl]);
  return null;
}
