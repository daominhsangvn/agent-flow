import path from "node:path";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { z } from "zod";
import { getAppBaseUrl, getAppOrigin, isLocalUrl } from "./api-url";
import { readEnv } from "./env";
import { pollUntil } from "./poll";

/**
 * Better Auth helpers for the e2e harness.
 *
 * Better Auth is served by apps/api at /api/auth/* and reached through the
 * web app's rewrite, so its httpOnly session cookie is first-party to the web
 * app origin. Every call here goes to the WEB origin through a request
 * context that shares the browser cookie jar (`page.request` /
 * `context.request`), exactly like the browser does.
 *
 * - Cookie-carrying POSTs must send `Origin: <web app origin>`; Better Auth
 *   rejects any origin outside its trustedOrigins.
 * - GET /api/auth/token is cookie-only and mints a 15-minute JWT. Mint it per
 *   test (getSessionBearerToken) and never persist it.
 */

export const AUTH_BASE_PATH = "/api/auth";

/** Storage state written by e2e/auth.setup.ts and loaded by the chromium project. */
export const AUTH_STATE_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  ".auth",
  "user.json"
);

/** `org_role` claim values of the session JWT (apps/api/lib/auth/better-auth.ts). */
export const OrgRole = {
  Owner: "org:owner",
  Admin: "org:admin",
  Member: "org:member",
} as const;
export type OrgRole = (typeof OrgRole)[keyof typeof OrgRole];

export type E2ECredentials = {
  email: string;
  password: string;
  name: string;
};

export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

export type OrgSessionClaims = {
  userId: string;
  orgId: string;
  orgSlug: string;
  orgRole: string;
};

const DEFAULT_E2E_EMAIL = "e2e@example.com";
const DEFAULT_E2E_NAME = "E2E Bot";
/** Used only when the target is localhost; remote targets must set E2E_USER_PASSWORD. */
const LOCAL_DEFAULT_E2E_PASSWORD = "e2e-local-password";
const DEFAULT_SESSION_WAIT_MS = 15_000;
const JWT_SEGMENT_COUNT = 3;
const ADMIN_ROLES: ReadonlySet<string> = new Set([
  OrgRole.Owner,
  OrgRole.Admin,
]);

const HttpStatus = {
  Unauthorized: 401,
  Forbidden: 403,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
} as const;

const USER_ALREADY_EXISTS_CODE_PREFIX = "USER_ALREADY_EXISTS";

const sessionClaimsSchema = z.object({
  sub: z.string().min(1),
  exp: z.number(),
  email: z.string().nullish(),
  org_id: z.string().nullish(),
  org_slug: z.string().nullish(),
  org_role: z.string().nullish(),
});

const tokenResponseSchema = z.object({ token: z.string().min(1) });

const sessionResponseSchema = z
  .object({ user: z.object({ id: z.string().min(1) }) })
  .nullable();

const authErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export function getE2ECredentials(
  env: NodeJS.ProcessEnv = process.env
): E2ECredentials {
  return {
    email: readEnv("E2E_USER_EMAIL", env) ?? DEFAULT_E2E_EMAIL,
    password:
      readEnv("E2E_USER_PASSWORD", env) ??
      readEnv("DEVOPS_AGENTFLOW_APP_PWD", env) ??
      localDefaultPassword(env),
    name: readEnv("E2E_USER_NAME", env) ?? DEFAULT_E2E_NAME,
  };
}

export function authUrl(endpoint: string): string {
  return `${getAppBaseUrl()}${AUTH_BASE_PATH}${endpoint}`;
}

export function signInViaApi(
  request: APIRequestContext,
  credentials: E2ECredentials = getE2ECredentials()
): Promise<APIResponse> {
  return request.post(authUrl("/sign-in/email"), {
    data: { email: credentials.email, password: credentials.password },
    headers: originHeaders(),
  });
}

export function signUpViaApi(
  request: APIRequestContext,
  credentials: E2ECredentials = getE2ECredentials()
): Promise<APIResponse> {
  return request.post(authUrl("/sign-up/email"), {
    data: {
      name: credentials.name,
      email: credentials.email,
      password: credentials.password,
    },
    headers: originHeaders(),
  });
}

export function signOutViaApi(
  request: APIRequestContext
): Promise<APIResponse> {
  return request.post(authUrl("/sign-out"), {
    data: {},
    headers: originHeaders(),
  });
}

/**
 * Signs the e2e user in, creating the account on first use. The session
 * cookie lands in the cookie jar of `request` (pass `page.request` so the
 * browser context is signed in too).
 */
export async function ensureE2EUser(
  request: APIRequestContext,
  credentials: E2ECredentials = getE2ECredentials()
): Promise<void> {
  const signIn = await signInViaApi(request, credentials);
  if (signIn.ok()) {
    return;
  }
  if (signIn.status() !== HttpStatus.Unauthorized) {
    throw await describeAuthFailure("sign-in", signIn, credentials);
  }

  const signUp = await signUpViaApi(request, credentials);
  if (signUp.ok()) {
    return;
  }
  throw await describeAuthFailure("sign-up", signUp, credentials);
}

/** Mints a 15-minute session JWT from the Better Auth session cookie. */
export async function getSessionBearerToken(
  source: Page | APIRequestContext
): Promise<string> {
  const response = await toRequestContext(source).get(authUrl("/token"));
  if (!response.ok()) {
    throw new Error(
      `GET ${AUTH_BASE_PATH}/token answered ${response.status()}: this browser context has no Better Auth session. ` +
        `Run the "setup" project first (it writes ${AUTH_STATE_PATH}), or sign in with ensureE2EUser(page.request).`
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `GET ${AUTH_BASE_PATH}/token returned an unexpected body: ${parsed.error.message}`
    );
  }
  return parsed.data.token;
}

/**
 * Decodes (without verifying) the payload of a session JWT. The API verifies
 * the signature; tests only read the claims.
 */
export function decodeSessionClaims(token: string): SessionClaims {
  const segments = token.split(".");
  if (segments.length !== JWT_SEGMENT_COUNT) {
    throw new Error("Session token is not a JWT");
  }
  const payload: unknown = JSON.parse(
    Buffer.from(segments[1], "base64url").toString("utf8")
  );
  return sessionClaimsSchema.parse(payload);
}

/**
 * Org claims of the session, failing with an actionable message when the
 * user has no active organization (the API answers 401 for such tokens).
 */
export function requireOrgClaims(token: string): OrgSessionClaims {
  const claims = decodeSessionClaims(token);
  if (!(claims.org_id && claims.org_slug && claims.org_role)) {
    throw new Error(
      `The e2e user (${claims.email ?? claims.sub}) has no active organization, so the API rejects its token. ` +
        "Unset AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION=false on the API, or invite the user into an organization."
    );
  }
  return {
    userId: claims.sub,
    orgId: claims.org_id,
    orgSlug: claims.org_slug,
    orgRole: claims.org_role,
  };
}

export function isOrgAdminRole(role: string | null | undefined): boolean {
  return role ? ADMIN_ROLES.has(role) : false;
}

/** Waits until the context's session cookie resolves to a signed-in user. */
export async function waitForSignedInSession(
  page: Page,
  timeoutMs = DEFAULT_SESSION_WAIT_MS
): Promise<string> {
  let lastStatus = "no response";
  return await pollUntil(
    async () => {
      const response = await page.request.get(authUrl("/get-session"));
      lastStatus = String(response.status());
      if (!response.ok()) {
        return null;
      }
      const parsed = sessionResponseSchema.safeParse(await response.json());
      return parsed.success && parsed.data ? parsed.data.user.id : null;
    },
    {
      description: "a signed-in Better Auth session",
      timeoutMs,
      describeLastAttempt: () =>
        `GET ${AUTH_BASE_PATH}/get-session ${lastStatus}`,
    }
  );
}

function originHeaders(): Record<string, string> {
  return { Origin: getAppOrigin() };
}

function toRequestContext(source: Page | APIRequestContext): APIRequestContext {
  return "goto" in source ? source.request : source;
}

function localDefaultPassword(env: NodeJS.ProcessEnv): string {
  const baseUrl = getAppBaseUrl(env);
  if (isLocalUrl(baseUrl)) {
    return LOCAL_DEFAULT_E2E_PASSWORD;
  }
  throw new Error(
    `E2E_USER_PASSWORD is required when BASE_URL is not localhost (BASE_URL=${baseUrl}).`
  );
}

async function readAuthError(
  response: APIResponse
): Promise<z.infer<typeof authErrorBodySchema>> {
  try {
    const parsed = authErrorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

async function describeAuthFailure(
  step: "sign-in" | "sign-up",
  response: APIResponse,
  credentials: E2ECredentials
): Promise<Error> {
  const body = await readAuthError(response);
  const detail = [
    `${step} for ${credentials.email} answered ${response.status()}`,
    body.code,
    body.message,
  ]
    .filter(Boolean)
    .join(" ");
  return new Error(`${detail}. ${authFailureHint(response.status(), body)}`);
}

function authFailureHint(
  status: number,
  body: z.infer<typeof authErrorBodySchema>
): string {
  if (
    status === HttpStatus.UnprocessableEntity ||
    body.code?.startsWith(USER_ALREADY_EXISTS_CODE_PREFIX)
  ) {
    return "The account exists but the password does not match: set E2E_USER_PASSWORD to its password, or use another E2E_USER_EMAIL.";
  }
  if (status === HttpStatus.Forbidden) {
    return "Sign-up is invitation-only: unset AUTH_ALLOW_SIGN_UP=false on the API, or invite E2E_USER_EMAIL first.";
  }
  if (status === HttpStatus.TooManyRequests) {
    return "Better Auth rate-limited the request (production builds allow 3 sign-ins per 10s); wait and retry.";
  }
  return `Check that the web app at ${getAppBaseUrl()} proxies ${AUTH_BASE_PATH} to the API and that BETTER_AUTH_URL equals ${getAppOrigin()}.`;
}
