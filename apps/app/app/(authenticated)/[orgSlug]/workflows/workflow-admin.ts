import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { auth } from "@repo/auth/server";

/**
 * Whether the signed-in member may change workflows: organization admins and
 * owners only (the API enforces the same rule with `getOrgAdminStatus`).
 * Members still read workflows and their runs.
 */
export async function resolveWorkflowAdmin(): Promise<boolean> {
  const { orgRole } = await auth();
  return isAdminRole(orgRole ?? undefined);
}
