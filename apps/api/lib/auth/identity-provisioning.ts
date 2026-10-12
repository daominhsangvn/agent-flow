import "server-only";

import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { splitDisplayName } from "./identity-service";

/**
 * Membership provisioning and application-table sync for Better Auth.
 *
 * Self-hosted deployments are single-tenant by default: every account lands in
 * one organization. A new account joins, in order of preference:
 *   1. every organization with a pending, unexpired invitation for its email
 *      (with the invited role);
 *   2. otherwise the oldest organization, as a member
 *      (`AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION=false` turns this off);
 *   3. otherwise a new default organization, as its owner — the first account
 *      on a fresh install.
 *
 * The application's own `users`/`organizations` rows are still created lazily
 * on first API request (`findOrCreateUser`); the hooks below only propagate
 * later profile changes and removals, which the Clerk webhooks used to do.
 */

const DEFAULT_ORGANIZATION_NAME = "AgentFlow";
const DEFAULT_ORGANIZATION_SLUG = "agentflow";
const OwnerRole = "owner";
const MemberRole = "member";
const InvitationStatus = {
  Pending: "pending",
  Accepted: "accepted",
} as const;

type IdentityUserRecord = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};
type IdentityOrganizationRecord = { id: string; name: string; slug: string };

export async function provisionNewUser(
  user: IdentityUserRecord
): Promise<void> {
  const joinedFromInvitations = await acceptPendingInvitations(user);
  if (joinedFromInvitations === 0) {
    try {
      await joinDefaultOrganization(user);
    } catch (error) {
      // Two first sign-ups racing on an empty install can both try to create
      // the default organization; the loser joins the winner's.
      if (getPrismaErrorCode(error) !== "P2002") {
        throw error;
      }
      await joinDefaultOrganization(user);
    }
  }
  await activateDefaultOrganization(user.id);
}

/**
 * Better Auth creates the sign-up session before the user-created hook runs,
 * so that session starts without an active organization. Point every such
 * session of this user at their default organization.
 */
async function activateDefaultOrganization(userId: string): Promise<void> {
  const organizationId = await defaultActiveOrganizationId(userId);
  if (!organizationId) {
    return;
  }
  await withDb((db) =>
    db.authSession.updateMany({
      where: { userId, activeOrganizationId: null },
      data: { activeOrganizationId: organizationId },
    })
  );
}

/** Whether an unexpired invitation is waiting for this email address. */
export async function hasPendingInvitation(email: string): Promise<boolean> {
  const invitation = await withDb((db) =>
    db.authInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        status: InvitationStatus.Pending,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    })
  );
  return invitation !== null;
}

/** The organization a new session starts in: the user's oldest membership. */
export async function defaultActiveOrganizationId(
  userId: string
): Promise<string | null> {
  const member = await withDb((db) =>
    db.authMember.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true },
    })
  );
  return member?.organizationId ?? null;
}

export async function syncUserProfile(user: IdentityUserRecord): Promise<void> {
  const { firstName, lastName } = splitDisplayName(user.name);
  await usersService.updateByClerkId(user.id, {
    email: user.email,
    firstName,
    lastName,
    avatarUrl: user.image ?? null,
  });
}

export async function syncOrganizationUpdate(
  organization: IdentityOrganizationRecord | null
): Promise<void> {
  if (!organization) {
    return;
  }
  const existing = await organizationsService.findByClerkId(organization.id);
  if (!existing) {
    return;
  }
  await organizationsService.updateByClerkId(organization.id, {
    name: organization.name,
    slug: organization.slug,
  });
}

export async function syncOrganizationDeleted(
  organizationId: string
): Promise<void> {
  const existing = await organizationsService.findByClerkId(organizationId);
  if (existing) {
    await organizationsService.deactivateByClerkId(organizationId);
  }
}

export async function syncMemberAdded(
  user: IdentityUserRecord,
  organization: IdentityOrganizationRecord
): Promise<void> {
  const localOrganization = await organizationsService.findOrCreateByClerkId(
    organization.id,
    { name: organization.name, slug: organization.slug }
  );
  const { firstName, lastName } = splitDisplayName(user.name);
  await usersService.upsertByClerkIdAndOrg({
    clerkId: user.id,
    organizationId: localOrganization.id,
    email: user.email,
    firstName,
    lastName,
    avatarUrl: user.image ?? null,
  });
}

export async function syncMemberRemoved(
  userId: string,
  organizationId: string
): Promise<void> {
  const localOrganization =
    await organizationsService.findByClerkId(organizationId);
  if (!localOrganization) {
    return;
  }
  try {
    await usersService.deactivateByClerkIdAndOrg(userId, localOrganization.id);
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2025") {
      throw error;
    }
    log.info("[identity] removed member had no application user row", {
      userId,
      organizationId: localOrganization.id,
    });
  }
}

async function acceptPendingInvitations(
  user: IdentityUserRecord
): Promise<number> {
  const now = new Date();
  return await withDb.tx(async (tx) => {
    const invitations = await tx.authInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        status: InvitationStatus.Pending,
        expiresAt: { gt: now },
      },
      select: { id: true, organizationId: true, role: true },
    });
    for (const invitation of invitations) {
      await tx.authMember.create({
        data: {
          id: randomUUID(),
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role ?? MemberRole,
          createdAt: now,
        },
      });
      await tx.authInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.Accepted },
      });
    }
    return invitations.length;
  });
}

async function joinDefaultOrganization(
  user: IdentityUserRecord
): Promise<void> {
  const now = new Date();
  await withDb.tx(async (tx) => {
    const existing = await tx.authOrganization.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      if (process.env.AUTH_AUTO_JOIN_DEFAULT_ORGANIZATION === "false") {
        log.info("[identity] new account left without an organization", {
          userId: user.id,
        });
        return;
      }
      await tx.authMember.create({
        data: {
          id: randomUUID(),
          organizationId: existing.id,
          userId: user.id,
          role: MemberRole,
          createdAt: now,
        },
      });
      return;
    }
    const organization = await tx.authOrganization.create({
      data: {
        id: randomUUID(),
        name:
          process.env.AUTH_DEFAULT_ORGANIZATION_NAME ||
          DEFAULT_ORGANIZATION_NAME,
        slug:
          process.env.AUTH_DEFAULT_ORGANIZATION_SLUG ||
          DEFAULT_ORGANIZATION_SLUG,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.authMember.create({
      data: {
        id: randomUUID(),
        organizationId: organization.id,
        userId: user.id,
        role: OwnerRole,
        createdAt: now,
      },
    });
    log.info("[identity] created the default organization", {
      organizationId: organization.id,
      ownerUserId: user.id,
    });
  });
}
