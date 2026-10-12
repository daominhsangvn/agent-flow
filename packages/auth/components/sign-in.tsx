"use client";

import { useState } from "react";
import { authApi, refreshSession } from "../auth-client";
import {
  AuthCard,
  AuthField,
  errorMessage,
  readRedirectTarget,
} from "./auth-card";

/** Email/password sign-in, with an inline "forgot password" request. */
export const SignIn = () => {
  const [mode, setMode] = useState<"sign-in" | "forgot">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signIn = async () => {
    setSubmitting(true);
    setError(null);
    const result = await authApi.signInEmail({ email, password });
    if (result.error) {
      setError(errorMessage(result.error, "Could not sign in"));
      setSubmitting(false);
      return;
    }
    await refreshSession();
    globalThis.location.assign(readRedirectTarget());
  };

  const requestReset = async () => {
    setSubmitting(true);
    setError(null);
    const result = await authApi.requestPasswordReset({
      email,
      redirectTo: `${globalThis.location.origin}/reset-password`,
    });
    setSubmitting(false);
    if (result.error) {
      setError(errorMessage(result.error, "Could not send the reset email"));
      return;
    }
    setNotice(
      "If an account exists for that email, a reset link is on its way."
    );
  };

  if (mode === "forgot") {
    return (
      <AuthCard
        description={
          notice ?? "We will email you a link to set a new password."
        }
        error={error}
        footer={
          <button
            className="underline"
            onClick={() => setMode("sign-in")}
            type="button"
          >
            Back to sign in
          </button>
        }
        onSubmit={requestReset}
        submitLabel="Send reset link"
        submitting={submitting}
        title="Reset your password"
      >
        <AuthField
          autoComplete="email"
          id="email"
          label="Email"
          onChange={setEmail}
          type="email"
          value={email}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      error={error}
      footer={
        <span>
          No account?{" "}
          <a className="underline" href="/sign-up">
            Create one
          </a>
        </span>
      }
      onSubmit={signIn}
      submitLabel="Sign in"
      submitting={submitting}
      title="Welcome to AgentFlow"
    >
      <AuthField
        autoComplete="email"
        id="email"
        label="Email"
        onChange={setEmail}
        type="email"
        value={email}
      />
      <AuthField
        autoComplete="current-password"
        id="password"
        label="Password"
        onChange={setPassword}
        type="password"
        value={password}
      />
      <button
        className="text-muted-foreground text-sm underline"
        onClick={() => setMode("forgot")}
        type="button"
      >
        Forgot password?
      </button>
    </AuthCard>
  );
};
