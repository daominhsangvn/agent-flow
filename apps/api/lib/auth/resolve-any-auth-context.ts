import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { isDesktopSessionToken } from "@repo/auth/desktop-session-jwt";
import { auth, verifyToken } from "@repo/auth/server";
import { ApiKeySource } from "@repo/database";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { waitUntil } from "@/lib/wait-until";
import type { VerifiedApiKeyContextWithMetadata } from "./api-key-context";
import {
  type AnyAuthContextResult,
  AuthContextFailure,
  ORG_UNVERIFIABLE,
  type ResolvedAuthContext,
  UNAUTHENTICATED,
} from "./auth-context-failure";
import {
  getDesktopManagedPopRequestFailure,
  resolveDesktopManagedPopMode,
} from "./desktop-managed-pop";
import { resolveDesktopSessionContext } from "./desktop-session-auth";
import { resolveOrgHeader } from "./resolve-org-header";

/**
 * Resolves user identity from either an API key (`sk_live_*`) or a session
 * JWT, returning a lightweight context suitable for SSE and streaming
 * endpoints that cannot use `withAnyAuth` (which requires NextResponse<ApiResult>).
 *
 * Returns a discriminated failure rather than a bare `null` so those boundaries
 * can answer the same 503 / `org_unverifiable` contract `withAuth` does
 * (ISS-5118). Collapsing an identity-provider outage into the 401 that means
 * "your credentials are bad" told the user to sign in again for a condition
 * signing in again cannot fix — see `authContextFailureResponse` in
 * `./auth-context-failure`.
 */
export async function resolveAnyAuthContext(
  request: Request,
  options?: { requiredScopes?: ApiKeyScope[] }
): Promise<AnyAuthContextResult> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token?.startsWith("sk_live_")) {
    return toResult(
      await resolveApiKeyTokenContext(token, {
        request,
        requiredScopes: options?.requiredScopes ?? ["read"],
      })
    );
  }

  // Desktop access tokens are preclassified by their non-secret `typ` header and
  // short-circuit here: a desktop-typed token that fails verification resolves
  // to a failure and MUST NOT fall through to session verification (FEA-2217
  // contract).
  if (token && isDesktopSessionToken(token)) {
    const desktopContext = await resolveDesktopSessionContext(token);
    if (!desktopContext) {
      return UNAUTHENTICATED;
    }
    return {
      ok: true,
      context: {
        organizationId: desktopContext.organizationId,
        userId: desktopContext.user.id,
      },
    };
  }

  if (token) {
    const bearerResult = await resolveSessionTokenContext(token, request);
    if (isConclusive(bearerResult)) {
      return bearerResult;
    }
  }

  return resolveSessionContext(request);
}

/**
 * Verifies an API key token and returns a lightweight auth context.
 * Exported for non-standard auth paths (Socket.IO, SSE) that extract
 * tokens outside the normal Request flow.
 */
export async function resolveApiKeyTokenContext(
  token: string,
  options:
    | ApiKeyScope[]
    | {
        request?: Request;
        requiredScopes?: ApiKeyScope[];
      } = {}
): Promise<ResolvedAuthContext | null> {
  const resolvedOptions = Array.isArray(options)
    ? { requiredScopes: options }
    : options;
  const requiredScopes = resolvedOptions.requiredScopes ?? ["read"];
  const keyContext = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
  if (!keyContext) {
    return null;
  }

  if (!requiredScopes.every((scope) => keyContext.scopes.includes(scope))) {
    return null;
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return null;
  }

  const popAccepted = await isDesktopManagedPopAccepted(
    { ...keyContext, clerkUserId: user.clerkId },
    resolvedOptions.request
  );
  if (!popAccepted) {
    return null;
  }

  const organization = await organizationsService.findById(
    keyContext.organizationId
  );
  if (!organization) {
    return null;
  }

  return {
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
  };
}

async function isDesktopManagedPopAccepted(
  keyContext: VerifiedApiKeyContextWithMetadata & {
    clerkUserId?: string | null;
  },
  request: Request | undefined
): Promise<boolean> {
  if (
    keyContext.source !== ApiKeySource.DESKTOP_MANAGED ||
    !(keyContext.boundPublicKey && keyContext.gatewayId)
  ) {
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  if (request) {
    const popFailure = await getDesktopManagedPopRequestFailure({
      keyContext,
      request,
    });
    if (popFailure) {
      return false;
    }
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  const mode = await resolveDesktopManagedPopMode(keyContext);
  if (mode !== "enforce") {
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  return false;
}

async function resolveSessionTokenContext(
  token: string,
  request?: Request
): Promise<AnyAuthContextResult> {
  try {
    const claims = await verifyToken(token);
    const clerkUserId = typeof claims.sub === "string" ? claims.sub : null;
    const clerkOrgId = typeof claims.org_id === "string" ? claims.org_id : null;

    if (!(clerkUserId && clerkOrgId)) {
      return UNAUTHENTICATED;
    }
    return await resolveIdentityContext(clerkUserId, clerkOrgId, request);
  } catch {
    return UNAUTHENTICATED;
  }
}

async function resolveSessionContext(
  request?: Request
): Promise<AnyAuthContextResult> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!(clerkUserId && clerkOrgId)) {
    return UNAUTHENTICATED;
  }

  return await resolveIdentityContext(clerkUserId, clerkOrgId, request);
}

async function resolveIdentityContext(
  clerkUserId: string,
  clerkOrgId: string,
  request?: Request
): Promise<AnyAuthContextResult> {
  let effectiveClerkOrgId = clerkOrgId;

  if (request) {
    const orgResolution = await resolveOrgHeader(
      request,
      clerkUserId,
      clerkOrgId
    );
    // Neither kind yields a trusted org context, but they are reported
    // differently (ISS-5118): `forbidden` is a DECISION about this caller, and
    // `unverifiable` means the provider never answered. Listed explicitly rather
    // than folded into a default so the next `OrgHeaderResult` kind has to be
    // classified here too.
    if (orgResolution.kind === "unverifiable") {
      return ORG_UNVERIFIABLE;
    }
    if (orgResolution.kind === "forbidden") {
      return UNAUTHENTICATED;
    }
    effectiveClerkOrgId = orgResolution.clerkOrgId;
  }

  const organization =
    await organizationsService.findByClerkId(effectiveClerkOrgId);
  if (!organization) {
    return UNAUTHENTICATED;
  }

  const user = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );
  if (!user?.active) {
    return UNAUTHENTICATED;
  }

  return {
    ok: true,
    context: { organizationId: organization.id, userId: user.id },
  };
}

/** Wrap a `context | null` resolver in the discriminated result. */
function toResult(context: ResolvedAuthContext | null): AnyAuthContextResult {
  return context ? { ok: true, context } : UNAUTHENTICATED;
}

/**
 * True when this result ends the search across auth mechanisms.
 *
 * A success obviously does. So does `OrgUnverifiable`: the remaining mechanisms
 * resolve the same org header against the same failing provider, so trying them
 * cannot succeed — it would only spend more calls on an outage and then report
 * the last one's generic 401, losing the reason we already know.
 */
function isConclusive(result: AnyAuthContextResult): boolean {
  return result.ok || result.failure === AuthContextFailure.OrgUnverifiable;
}
