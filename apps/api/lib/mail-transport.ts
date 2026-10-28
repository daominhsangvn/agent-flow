import "server-only";

import { createTransport, type Transporter } from "nodemailer";
import { z } from "zod";

/**
 * The server's outgoing mail: plain SMTP from `SMTP_URL` (Mailpit from
 * docker-compose.yml in development, any relay in production), sent from
 * `EMAIL_FROM`. Authentication flows (auth/auth-email.ts) and workflow email
 * actions (workflows/engine/email-action.ts) share it.
 */

export const DEFAULT_EMAIL_FROM = "AgentFlow <no-reply@localhost>";

export type OutgoingMail = {
  to: string | readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  /** Message-ID header; a retry with the same id lets mail clients de-duplicate. */
  messageId?: string;
};

export type MailFailure = { message: string; retryable: boolean };

let transporter: Transporter | null = null;

/** True when `SMTP_URL` is set, so mail is actually sent. */
export function isMailConfigured(): boolean {
  return readSmtpUrl() !== null;
}

/** Sends the mail; throws when `SMTP_URL` is unset or the relay refuses it. */
export async function sendMail(mail: OutgoingMail): Promise<void> {
  const smtpUrl = readSmtpUrl();
  if (!smtpUrl) {
    throw new Error("SMTP_URL is not set");
  }
  transporter ??= createTransport(smtpUrl);
  await transporter.sendMail({
    from: process.env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM,
    to: [mail.to].flat(),
    cc: mail.cc && mail.cc.length > 0 ? [...mail.cc] : undefined,
    subject: mail.subject,
    text: mail.text,
    messageId: mail.messageId,
  });
}

/**
 * What a failed send says, and whether trying again can help: the relay's
 * permanent refusals (5xx) cannot, a connection problem or a 4xx can.
 */
export function describeMailFailure(error: unknown): MailFailure {
  const parsed = smtpErrorSchema.safeParse(error);
  if (!parsed.success) {
    return { message: "The mail relay could not be reached", retryable: true };
  }
  const { responseCode, message } = parsed.data;
  if (responseCode !== undefined) {
    return {
      message: `The mail relay refused the message (${responseCode}): ${message}`,
      retryable: responseCode < SMTP_PERMANENT_FAILURE_MIN,
    };
  }
  return {
    message: `The mail relay could not be reached: ${message}`,
    retryable: true,
  };
}

const SMTP_PERMANENT_FAILURE_MIN = 500;

const smtpErrorSchema = z.object({
  message: z.string(),
  responseCode: z.number().optional(),
});

function readSmtpUrl(): string | null {
  const value = process.env.SMTP_URL?.trim();
  return value ? value : null;
}
