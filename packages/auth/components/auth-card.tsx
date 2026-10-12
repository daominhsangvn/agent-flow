"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import type { FormEvent, ReactNode } from "react";

/** Shared layout for the sign-in, sign-up and password reset forms. */
export function AuthCard({
  title,
  description,
  error,
  submitLabel,
  submitting,
  onSubmit,
  children,
  footer,
}: Readonly<{
  title: string;
  description?: string;
  error: string | null;
  submitLabel: string;
  submitting: boolean;
  onSubmit: () => void;
  children: ReactNode;
  footer?: ReactNode;
}>) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <Card className="w-full max-w-sm border-0 shadow-none">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <form noValidate onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {children}
          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? "Please wait…" : submitLabel}
          </Button>
        </CardContent>
      </form>
      {footer ? (
        <CardFooter className="justify-center text-muted-foreground text-sm">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function AuthField({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  disabled,
}: Readonly<{
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  disabled?: boolean;
}>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        autoComplete={autoComplete}
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        required
        type={type}
        value={value}
      />
    </div>
  );
}

/**
 * The post-auth destination from `?redirect_url=`, limited to same-origin
 * paths so the parameter cannot be used as an open redirect.
 */
export function readRedirectTarget(fallback = "/"): string {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get(
    "redirect_url"
  );
  if (!raw) {
    return fallback;
  }
  try {
    const url = new URL(raw, globalThis.location.origin);
    return url.origin === globalThis.location.origin
      ? `${url.pathname}${url.search}${url.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export function errorMessage(
  error: { message?: string } | null | undefined,
  fallback: string
): string {
  return error?.message || fallback;
}
