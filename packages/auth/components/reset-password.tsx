"use client";

import { useState } from "react";
import { authApi } from "../auth-client";
import { AuthCard, AuthField, errorMessage } from "./auth-card";

/** Landing page of the password-reset email (`?token=` from Better Auth). */
export const ResetPassword = () => {
  const [token] = useState(
    () =>
      new URLSearchParams(globalThis.location?.search ?? "").get("token") ?? ""
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    token ? null : "This reset link is invalid or has expired."
  );
  const [submitting, setSubmitting] = useState(false);

  const resetPassword = async () => {
    setSubmitting(true);
    setError(null);
    const result = await authApi.resetPassword({
      newPassword: password,
      token,
    });
    if (result.error) {
      setError(errorMessage(result.error, "Could not reset the password"));
      setSubmitting(false);
      return;
    }
    globalThis.location.assign("/sign-in");
  };

  return (
    <AuthCard
      error={error}
      onSubmit={resetPassword}
      submitLabel="Set new password"
      submitting={submitting || !token}
      title="Choose a new password"
    >
      <AuthField
        autoComplete="new-password"
        id="password"
        label="New password"
        onChange={setPassword}
        type="password"
        value={password}
      />
    </AuthCard>
  );
};
