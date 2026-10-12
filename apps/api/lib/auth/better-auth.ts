import "server-only";

import { randomUUID } from "node:crypto";
import { getPrismaClient, withDb } from "@repo/database";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import {
  appBaseUrl,
  sendInvitationEmail,
  sendPasswordResetEmail,
} from "./auth-email";
import {
  defaultActiveOrganizationId,
  hasPendingInvitation,
  provisionNewUser,
  syncMemberAdded,
  syncMemberRemoved,
  syncOrganizationDeleted,
  syncOrganizationUpdate,
  syncUserProfile,
} from "./identity-provisioning";
import { toOrgRole } from "./identity-service";

/**
 * The identity provider: email/password accounts, organizations, and the
 * short-lived JWTs the web app sends to this API (`Authorization: Bearer`).
 *
 * Mounted at `/api/auth/*` (app/api/auth/[...all]/route.ts). Browsers reach it
 * through the web app, which rewrites `/api/auth/*` here, so its cookies are
 * first-party to the web app origin (`BETTER_AUTH_URL`).
 *
 * JWT claims mirror what the code previously read from Clerk session tokens:
 * `sub` (user id), `org_id`, `org_slug`, `org_role` (`org:owner|admin|member`).
 */

const TOKEN_LIFETIME = "15m";
const MIN_PASSWORD_LENGTH = 8;
/** Matches the "expires in 7 days" promise in the invitation email. */
const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

export const AUTH_BASE_PATH = "/api/auth";

const betterAuthServer = betterAuth({
  appName: "AgentFlow",
  baseURL: appBaseUrl(),
  basePath: AUTH_BASE_PATH,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOrigins(),
  database: prismaAdapter(getPrismaClient(), { provider: "postgresql" }),
  advanced: {
    cookiePrefix: "agentflow",
    // Ids are generated here: the auth_* tables have no column defaults.
    database: { generateId: () => randomUUID() },
  },
  user: { modelName: "authUser" },
  session: { modelName: "authSession" },
  account: { modelName: "authAccount" },
  verification: { modelName: "authVerification" },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    sendResetPassword: ({ user, url }) =>
      sendPasswordResetEmail({ email: user.email, url }),
  },
  databaseHooks: {
    user: {
      create: {
        // `AUTH_ALLOW_SIGN_UP=false` makes the deployment invite-only: an
        // account can still be created for an email with a pending invitation.
        before: async (user) => {
          if (
            process.env.AUTH_ALLOW_SIGN_UP === "false" &&
            !(await hasPendingInvitation(user.email))
          ) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is by invitation only",
            });
          }
        },
        after: (user) => provisionNewUser(user),
      },
      update: { after: (user) => syncUserProfile(user) },
    },
    session: {
      create: {
        before: async (session) => ({
          data: {
            ...session,
            activeOrganizationId:
              session.activeOrganizationId ??
              (await defaultActiveOrganizationId(session.userId)),
          },
        }),
      },
    },
  },
  plugins: [
    organization({
      invitationExpiresIn: INVITATION_LIFETIME_SECONDS,
      allowUserToCreateOrganization:
        process.env.AUTH_ALLOW_CREATE_ORGANIZATION === "true",
      schema: {
        organization: { modelName: "authOrganization" },
        member: { modelName: "authMember" },
        invitation: { modelName: "authInvitation" },
      },
      sendInvitationEmail: ({ email, organization: invitedTo, inviter }) =>
        sendInvitationEmail({
          email,
          organizationName: invitedTo.name,
          inviterName: inviter.user.name || inviter.user.email,
        }),
      organizationHooks: {
        afterUpdateOrganization: ({ organization: updated }) =>
          syncOrganizationUpdate(updated),
        afterDeleteOrganization: ({ organization: deleted }) =>
          syncOrganizationDeleted(deleted.id),
        afterAddMember: ({ user, organization: joined }) =>
          syncMemberAdded(user, joined),
        afterRemoveMember: ({ user, organization: left }) =>
          syncMemberRemoved(user.id, left.id),
      },
    }),
    jwt({
      schema: { jwks: { modelName: "authJwks" } },
      jwt: {
        issuer: appBaseUrl(),
        audience: appBaseUrl(),
        expirationTime: TOKEN_LIFETIME,
        definePayload: async ({ user, session }) =>
          buildTokenClaims(
            user,
            session.activeOrganizationId ??
              (await defaultActiveOrganizationId(user.id))
          ),
      },
    }),
  ],
});

/** Request handler for the `/api/auth/*` route. */
export const betterAuthHandler: (request: Request) => Promise<Response> =
  betterAuthServer.handler;

async function buildTokenClaims(
  user: { id: string; email: string; name: string; image?: string | null },
  activeOrganizationId: string | null
): Promise<Record<string, unknown>> {
  const claims: Record<string, unknown> = {
    email: user.email,
    name: user.name,
    image: user.image ?? null,
  };
  if (!activeOrganizationId) {
    return claims;
  }
  const member = await withDb((db) =>
    db.authMember.findFirst({
      where: { organizationId: activeOrganizationId, userId: user.id },
      select: {
        role: true,
        organization: { select: { name: true, slug: true, logo: true } },
      },
    })
  );
  if (!member) {
    return claims;
  }
  return {
    ...claims,
    org_id: activeOrganizationId,
    org_slug: member.organization.slug,
    org_name: member.organization.name,
    org_logo: member.organization.logo,
    org_role: toOrgRole(member.role),
  };
}

function trustedOrigins(): string[] {
  const extra = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [new URL(appBaseUrl()).origin, ...extra];
}
