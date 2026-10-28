import "server-only";

import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { withDb } from "@repo/database";

/**
 * Resolves the display identity for a signed-in desktop session: the user's
 * name/email plus their organization's name and URL slug. Org-scoped to the authenticated
 * user so a token can only ever read its own identity.
 */
export const desktopIdentityService = {
  async get(
    userId: string,
    organizationId: string
  ): Promise<DesktopIdentity | null> {
    const user = await withDb((db) =>
      db.user.findFirst({
        where: { id: userId, organizationId },
        select: {
          id: true,
          organizationId: true,
          email: true,
          firstName: true,
          lastName: true,
          organization: {
            select: { name: true, slug: true },
          },
        },
      })
    );

    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationName: user.organization?.name ?? null,
      // ISS-4898: the org slug the web app's artifact routes are scoped by, so
      // the desktop renderer can build `/<orgSlug>/issues/<slug>` and open a
      // linked artifact in the browser. OMITTED rather than sent as `null` when
      // the organization row could not be read — an absent optional field is
      // the wire shape old and new desktops both handle, and a `null` here would
      // only invite a consumer to interpolate it into a URL.
      ...(user.organization?.slug
        ? { organizationSlug: user.organization.slug }
        : {}),
      // Session sync is always on: there is no org policy to switch it off.
      // Still sent explicitly, with its ISS-4705 capability marker, because
      // installed desktops gate their sync egress on it and fail closed when a
      // capable server drops the field.
      sessionSyncPolicyEnabled: true,
      sessionSyncPolicySupported: true,
    };
  },
};
