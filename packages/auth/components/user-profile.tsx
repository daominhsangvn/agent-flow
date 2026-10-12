"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { type FormEvent, useEffect, useState } from "react";
import { authApi, refreshSession, useSessionSnapshot } from "../auth-client";
import { errorMessage } from "./auth-card";

const MIN_PASSWORD_LENGTH = 8;

/** Profile settings: display name and password. */
export function UserProfile(_props: Readonly<Record<string, unknown>>) {
  const session = useSessionSnapshot();
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(session.claims?.name ?? "");
  }, [session.claims?.name]);

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await authApi.updateUser({ name });
    setBusy(false);
    if (result.error) {
      setError(errorMessage(result.error, "Could not update your name"));
      return;
    }
    await refreshSession();
    setNotice("Name updated.");
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Use at least ${MIN_PASSWORD_LENGTH} characters for the password`
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await authApi.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (result.error) {
      setError(errorMessage(result.error, "Could not change your password"));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setNotice("Password changed. Other sessions were signed out.");
  };

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1">
        <p className="text-muted-foreground text-sm">Email</p>
        <p>{session.claims?.email ?? ""}</p>
      </div>

      <form className="flex items-end gap-2" onSubmit={saveName}>
        <div className="flex-1 space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            autoComplete="name"
            id="profile-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <Button disabled={busy || !name.trim()} type="submit" variant="outline">
          Save
        </Button>
      </form>

      <form className="space-y-3" onSubmit={changePassword}>
        <h3 className="font-medium">Change password</h3>
        <div className="space-y-2">
          <Label htmlFor="profile-current-password">Current password</Label>
          <Input
            autoComplete="current-password"
            id="profile-current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
            type="password"
            value={currentPassword}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-new-password">New password</Label>
          <Input
            autoComplete="new-password"
            id="profile-new-password"
            onChange={(event) => setNewPassword(event.target.value)}
            type="password"
            value={newPassword}
          />
        </div>
        <Button
          disabled={busy || !currentPassword || !newPassword}
          type="submit"
        >
          Change password
        </Button>
      </form>
    </div>
  );
}
