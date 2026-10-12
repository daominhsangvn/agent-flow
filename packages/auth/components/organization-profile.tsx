"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type AuthResult,
  type AuthRoleName,
  authApi,
  type FullOrganization,
  refreshSession,
  useSessionSnapshot,
} from "../auth-client";
import { errorMessage } from "./auth-card";

const AuthRole = {
  Owner: "owner",
  Admin: "admin",
  Member: "member",
} as const satisfies Record<string, AuthRoleName>;
type AuthRole = AuthRoleName;
const MANAGER_ROLES = new Set(["org:owner", "org:admin"]);

type MemberRow = FullOrganization["members"][number];
type InvitationRow = FullOrganization["invitations"][number];

/**
 * Organization settings: members, roles and invitations. Owners and admins can
 * invite, change roles and remove members; everyone else sees the roster.
 */
export function OrganizationProfile(_props: Readonly<Record<string, unknown>>) {
  const session = useSessionSnapshot();
  const canManage = MANAGER_ROLES.has(session.claims?.org_role ?? "");
  const currentUserId = session.claims?.sub ?? null;
  const [name, setName] = useState("");
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AuthRole>(AuthRole.Member);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await authApi.getFullOrganization();
    if (result.error || !result.data) {
      setError(errorMessage(result.error, "Could not load the organization"));
      return;
    }
    setName(result.data.name);
    setMembers(result.data.members);
    setInvitations(
      result.data.invitations.filter((i) => i.status === "pending")
    );
  }, []);

  useEffect(() => {
    if (session.status === "signed-in") {
      load().catch(() => undefined);
    }
  }, [session.status, load]);

  const run = async (action: () => Promise<AuthResult>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.error) {
      setError(errorMessage(result.error, "The change was not saved"));
      return;
    }
    await load();
  };

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const result = await authApi.updateOrganization({ name });
      await refreshSession();
      return result;
    }).catch(() => undefined);
  };

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const result = await authApi.inviteMember({
        email: inviteEmail,
        role: inviteRole,
      });
      if (!result.error) {
        setInviteEmail("");
      }
      return result;
    }).catch(() => undefined);
  };

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form className="flex items-end gap-2" onSubmit={rename}>
        <div className="flex-1 space-y-2">
          <Label htmlFor="org-profile-name">Organization name</Label>
          <Input
            disabled={!canManage}
            id="org-profile-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        {canManage ? (
          <Button
            disabled={busy || !name.trim()}
            type="submit"
            variant="outline"
          >
            Save
          </Button>
        ) : null}
      </form>

      <section className="space-y-2">
        <h3 className="font-medium">Members</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              {canManage ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>{member.user.name}</TableCell>
                <TableCell>{member.user.email}</TableCell>
                <TableCell>
                  {canManage && member.user.id !== currentUserId ? (
                    <select
                      aria-label={`Role for ${member.user.email}`}
                      className="rounded border bg-background px-2 py-1 text-sm"
                      disabled={busy}
                      onChange={(event) =>
                        run(() =>
                          authApi.updateMemberRole({
                            memberId: member.id,
                            role: event.target.value as AuthRole,
                          })
                        )
                      }
                      value={member.role}
                    >
                      {Object.values(AuthRole).map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge variant="secondary">{member.role}</Badge>
                  )}
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    {member.user.id === currentUserId ? null : (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(() => authApi.removeMember(member.id))
                        }
                        size="sm"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {canManage ? (
        <section className="space-y-2">
          <h3 className="font-medium">Invite a member</h3>
          <form className="flex items-end gap-2" onSubmit={invite}>
            <div className="flex-1 space-y-2">
              <Label htmlFor="org-invite-email">Email</Label>
              <Input
                id="org-invite-email"
                onChange={(event) => setInviteEmail(event.target.value)}
                type="email"
                value={inviteEmail}
              />
            </div>
            <select
              aria-label="Invited role"
              className="h-9 rounded border bg-background px-2 text-sm"
              onChange={(event) =>
                setInviteRole(event.target.value as AuthRole)
              }
              value={inviteRole}
            >
              <option value={AuthRole.Member}>member</option>
              <option value={AuthRole.Admin}>admin</option>
            </select>
            <Button disabled={busy || !inviteEmail.trim()} type="submit">
              Invite
            </Button>
          </form>
          {invitations.length > 0 ? (
            <ul className="space-y-1 text-muted-foreground text-sm">
              {invitations.map((invitation) => (
                <li
                  className="flex items-center justify-between"
                  key={invitation.id}
                >
                  <span>
                    {invitation.email} · {invitation.role ?? AuthRole.Member} ·
                    pending
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() => authApi.cancelInvitation(invitation.id))
                    }
                    size="sm"
                    variant="ghost"
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
