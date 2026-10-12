import { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { jsonObjectSchema } from "@/lib/json-schema";
import { httpUrlSchema } from "./urls";

/**
 * JSON body accepted by the `webhook.request` trigger, both on the inbound
 * URL and as manual-run input. Unknown properties are ignored; null is
 * accepted wherever a property is optional.
 */

export const WEBHOOK_REQUEST_ID_MAX_LENGTH = 255;
export const WEBHOOK_REQUEST_KEY_MAX_LENGTH = 120;
export const WEBHOOK_REQUEST_TITLE_MAX_LENGTH = 300;
export const WEBHOOK_REQUEST_DESCRIPTION_MAX_LENGTH = 100_000;
export const WEBHOOK_REQUEST_TYPE_MAX_LENGTH = 64;
export const WEBHOOK_REQUEST_LABELS_MAX = 50;

const LABEL_MAX_LENGTH = 100;
const MAX_REPORTED_ISSUES = 3;
const ISSUE_SUMMARY_MAX_LENGTH = 500;

export const webhookRequestBodySchema = z.object({
  id: z.string().trim().min(1).max(WEBHOOK_REQUEST_ID_MAX_LENGTH).nullish(),
  key: z.string().trim().min(1).max(WEBHOOK_REQUEST_KEY_MAX_LENGTH).nullish(),
  title: z.string().trim().min(1).max(WEBHOOK_REQUEST_TITLE_MAX_LENGTH),
  description: z.string().max(WEBHOOK_REQUEST_DESCRIPTION_MAX_LENGTH).nullish(),
  url: httpUrlSchema.nullish(),
  type: z.string().trim().min(1).max(WEBHOOK_REQUEST_TYPE_MAX_LENGTH).nullish(),
  labels: z
    .array(z.string().trim().min(1).max(LABEL_MAX_LENGTH))
    .max(WEBHOOK_REQUEST_LABELS_MAX)
    .nullish(),
  callbackUrl: httpUrlSchema.nullish(),
  metadata: jsonObjectSchema.nullish(),
});
export type WebhookRequestBody = z.infer<typeof webhookRequestBodySchema>;

/** Parses and validates a raw JSON body; the error is a short, user-facing issue summary. */
export function parseWebhookRequestBody(
  rawBody: string
): Result<WebhookRequestBody, string> {
  const json = parseJson(rawBody);
  if (!json.ok) {
    return Result.err("body is not valid JSON");
  }
  const parsed = webhookRequestBodySchema.safeParse(json.value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(summarizeZodIssues(parsed.error));
}

export function summarizeZodIssues(error: z.ZodError): string {
  const parts = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
  const remaining = error.issues.length - MAX_REPORTED_ISSUES;
  if (remaining > 0) {
    parts.push(`${remaining} more`);
  }
  return parts.join("; ").slice(0, ISSUE_SUMMARY_MAX_LENGTH);
}

function issuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "body";
}

function parseJson(text: string): Result<unknown, null> {
  try {
    return Result.ok(JSON.parse(text));
  } catch {
    return Result.err(null);
  }
}
