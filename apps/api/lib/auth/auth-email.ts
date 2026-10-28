import "server-only";

import { log } from "@repo/observability/log";
import { isMailConfigured, sendMail } from "@/lib/mail-transport";

/**
 * Transactional mail for authentication flows (invitations, password resets),
 * sent through the server's mail relay (lib/mail-transport.ts). Without
 * `SMTP_URL` the message is logged instead, so a local install still exposes
 * the link.
 */

type AuthEmail = {
  to: string;
  subject: string;
  text: string;
};

export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  if (!isMailConfigured()) {
    log.info("[auth-email] SMTP_URL not set; email not sent", {
      to: email.to,
      subject: email.subject,
      body: email.text,
    });
    return;
  }
  await sendMail(email);
}

export function sendInvitationEmail(params: {
  email: string;
  organizationName: string;
  inviterName: string;
}): Promise<void> {
  const signUpUrl = new URL("/sign-up", appBaseUrl());
  signUpUrl.searchParams.set("email", params.email);
  return sendAuthEmail({
    to: params.email,
    subject: `${params.inviterName} invited you to ${params.organizationName} on AgentFlow`,
    text: [
      `${params.inviterName} invited you to join ${params.organizationName} on AgentFlow.`,
      "",
      `Create your account with this email address to accept: ${signUpUrl.toString()}`,
      "",
      "The invitation expires in 7 days.",
    ].join("\n"),
  });
}

export function sendPasswordResetEmail(params: {
  email: string;
  url: string;
}): Promise<void> {
  return sendAuthEmail({
    to: params.email,
    subject: "Reset your AgentFlow password",
    text: [
      "Someone asked to reset the password for your AgentFlow account.",
      "",
      `Set a new password: ${params.url}`,
      "",
      "If this was not you, ignore this email.",
    ].join("\n"),
  });
}

export function appBaseUrl(): string {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}
