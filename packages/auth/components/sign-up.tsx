"use client";

import { useState } from "react";
import { authApi, refreshSession } from "../auth-client";
import {
  AuthCard,
  AuthField,
  errorMessage,
  readRedirectTarget,
} from "./auth-card";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Email/password sign-up. An invitation link pre-fills `?email=`; signing up
 * with that address joins the inviting organization.
 */
export const SignUp = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(
    () =>
      new URLSearchParams(globalThis.location?.search ?? "").get("email") ?? ""
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signUp = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Use at least ${MIN_PASSWORD_LENGTH} characters for the password`
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await authApi.signUpEmail({ name, email, password });
    if (result.error) {
      setError(errorMessage(result.error, "Could not create the account"));
      setSubmitting(false);
      return;
    }
    await refreshSession();
    globalThis.location.assign(readRedirectTarget());
  };

  return (
    <AuthCard
      error={error}
      footer={
        <span>
          Already have an account?{" "}
          <a className="underline" href="/sign-in">
            Sign in
          </a>
        </span>
      }
      onSubmit={signUp}
      submitLabel="Create account"
      submitting={submitting}
      title="Create your account"
    >
      <AuthField
        autoComplete="name"
        id="name"
        label="Name"
        onChange={setName}
        value={name}
      />
      <AuthField
        autoComplete="email"
        id="email"
        label="Email"
        onChange={setEmail}
        type="email"
        value={email}
      />
      <AuthField
        autoComplete="new-password"
        id="password"
        label="Password"
        onChange={setPassword}
        type="password"
        value={password}
      />
    </AuthCard>
  );
};
