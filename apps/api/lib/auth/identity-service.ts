import "server-only";

import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { sendInvitationEmail } from "./auth-email";

/**
 * Reads and writes identities in the Better Auth tables (`auth_*`). Replaces
 * the former Clerk Backend API client with the same five operations, so the
 * lazy user/organization provisioning in the services keeps working.
 *
 * Roles are exposed in the `org:<role>` form the rest of the API compares
 * against (`org:owner`, `org:admin`, `org:member`); Better Auth stores the bare
 * role name.
 */

export type IdentityOrganization = {
  id: string;
  name: string;
  slug: string | null;
};

export type IdentityUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  phoneNumber: string | null;
};

const ORG_ROLE_PREFIX = "org:";
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PendingInvitationStatus = "pending";

export const identityService = {
  async getOrganization(organizationId: string): Promise<IdentityOrganization> {
    const organization = await withDb((db) =>
      db.authOrganization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true },
      })
    );
    if (!organization) {
      throw new Error(`Organization ${organizationId} does not exist`);
    }
    return organization;
  },

  updateOrganization(
    organizationId: string,
    data: { slug?: string; name?: string }
  ): Promise<IdentityOrganization> {
    return withDb((db) =>
      db.authOrganization.update({
        where: { id: organizationId },
        data: {
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(data.name !== undefined && { name: data.name }),
        },
        select: { id: true, name: true, slug: true },
      })
    );
  },

  async getUser(userId: string): Promise<IdentityUser> {
    const user = await withDb((db) =>
      db.authUser.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, image: true },
      })
    );
    if (!user) {
      throw new Error(`User ${userId} does not exist`);
    }
    const { firstName, lastName } = splitDisplayName(user.name);
    return {
      id: user.id,
      email: user.email,
      firstName,
      lastName,
      imageUrl: user.image,
      phoneNumber: null,
    };
  },

  /**
   * Records a pending invitation and emails a sign-up link. When the invitee
   * signs up with that address, `provisionNewUser` adds them to the
   * organization with the invited role.
   */
  async createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }): Promise<{ id: string }> {
    const invitation = await withDb((db) =>
      db.authInvitation.create({
        data: {
          id: randomUUID(),
          organizationId: params.organizationId,
          email: params.emailAddress.toLowerCase(),
          role: toAuthRole(params.role),
          status: PendingInvitationStatus,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          inviterId: params.inviterUserId,
        },
        select: {
          id: true,
          email: true,
          organization: { select: { name: true } },
          inviter: { select: { name: true, email: true } },
        },
      })
    );
    await sendInvitationEmail({
      email: invitation.email,
      organizationName: invitation.organization.name,
      inviterName: invitation.inviter.name || invitation.inviter.email,
    });
    return { id: invitation.id };
  },

  async getOrganizationMembershipRole(
    organizationId: string,
    userId: string
  ): Promise<string | null> {
    const member = await withDb((db) =>
      db.authMember.findFirst({
        where: { organizationId, userId },
        select: { role: true },
      })
    );
    return member ? toOrgRole(member.role) : null;
  },
};

/** `admin` → `org:admin`. Better Auth may store several roles comma-joined. */
export function toOrgRole(authRole: string): string {
  const primary = authRole.split(",")[0]?.trim() || "member";
  return `${ORG_ROLE_PREFIX}${primary}`;
}

/** `org:admin` → `admin`; bare names pass through. */
export function toAuthRole(orgRole: string): string {
  return orgRole.startsWith(ORG_ROLE_PREFIX)
    ? orgRole.slice(ORG_ROLE_PREFIX.length)
    : orgRole;
}

export function splitDisplayName(name: string): {
  firstName: string | null;
  lastName: string | null;
} {
  const trimmed = name.trim();
  if (!trimmed) {
    return { firstName: null, lastName: null };
  }
  const separator = trimmed.indexOf(" ");
  if (separator === -1) {
    return { firstName: trimmed, lastName: null };
  }
  return {
    firstName: trimmed.slice(0, separator),
    lastName: trimmed.slice(separator + 1).trim() || null,
  };
}
