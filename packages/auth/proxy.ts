import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";
import type { AuthObject, MiddlewareAuth } from "./server-auth-object";
import { resolveSessionClaims } from "./session-token";
import { authStateFromClaims, hasAccess } from "./types";

export type { AuthObject, MiddlewareAuth } from "./server-auth-object";

type MiddlewareHandler = (
  auth: MiddlewareAuth,
  request: NextRequest,
  event: NextFetchEvent
) => Response | undefined | Promise<Response | undefined>;

type ContentSecurityPolicyOptions = {
  reportOnly?: boolean;
  strict?: boolean;
  directives?: Record<string, string[]>;
  reportTo?: string;
};

type AuthMiddlewareOptions = {
  contentSecurityPolicy?: ContentSecurityPolicyOptions;
};

/**
 * Next.js middleware wrapper. The handler receives a lazy `auth()` that
 * resolves the request's session only when called (bearer JWT first, then the
 * session cookie), so routes that never read identity pay nothing.
 *
 * Unlike Clerk's middleware this never blocks a request by itself; protected
 * layouts redirect when `auth()` reports no user.
 */
export function authMiddleware(
  handler?: MiddlewareHandler,
  options: AuthMiddlewareOptions = {}
) {
  return async (request: NextRequest, event: NextFetchEvent) => {
    let pending: Promise<AuthObject> | null = null;
    const lazyAuth: MiddlewareAuth = () => {
      pending ??= resolveRequestAuth(request);
      return pending;
    };
    const response =
      (await handler?.(lazyAuth, request, event)) ?? NextResponse.next();
    if (options.contentSecurityPolicy) {
      applyContentSecurityPolicy(response, options.contentSecurityPolicy);
    }
    return response;
  };
}

async function resolveRequestAuth(request: NextRequest): Promise<AuthObject> {
  const resolved = await resolveSessionClaims({
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie"),
  });
  const state = authStateFromClaims(resolved?.claims ?? null);
  const token = resolved?.token ?? null;
  return {
    ...state,
    getToken: () => Promise.resolve(token),
    has: (params) => hasAccess(state.orgRole, params),
    redirectToSignIn: () => {
      throw new Error(
        "redirectToSignIn is not available in middleware; return a redirect response"
      );
    },
    redirectToSignUp: () => {
      throw new Error(
        "redirectToSignUp is not available in middleware; return a redirect response"
      );
    },
  };
}

function applyContentSecurityPolicy(
  response: Response,
  csp: ContentSecurityPolicyOptions
): void {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "https:"],
    "connect-src": ["'self'"],
    ...mergeDirectives(csp.directives),
  };
  if (csp.reportTo) {
    directives["report-uri"] = [csp.reportTo];
  }
  const value = Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
  const header = csp.reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
  response.headers.set(header, value);
}

function mergeDirectives(
  extra: Record<string, string[]> | undefined
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(extra ?? {})) {
    merged[name] = name === "base-uri" ? sources : ["'self'", ...sources];
  }
  return merged;
}
