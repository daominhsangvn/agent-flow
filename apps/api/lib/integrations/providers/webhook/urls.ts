import { z } from "zod";

/**
 * URL handling for the generic HTTPS provider. Self-hosted installs
 * legitimately call internal services, so private hosts are allowed; only
 * non-http(s) schemes are refused.
 */

const HTTP_PROTOCOL_RE = /^https?$/;
const URL_MAX_LENGTH = 2048;
const URL_IN_TEXT_RE = /\bhttps?:\/\/\S+/gi;

export const httpUrlSchema = z
  .url({
    protocol: HTTP_PROTOCOL_RE,
    error: "Enter an absolute http:// or https:// URL",
  })
  .max(URL_MAX_LENGTH);

/** Optional URL form field: blank strings and null mean "not set". */
export const optionalHttpUrlSchema = z.preprocess(
  blankToUndefined,
  httpUrlSchema.optional()
);

/** The value when it is an absolute http(s) URL, otherwise null (for stored, untrusted values). */
export function readHttpUrl(value: unknown): string | null {
  const parsed = httpUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Removes URLs from transport error text (callback URLs may embed tokens). */
export function redactUrls(text: string): string {
  return text.replaceAll(URL_IN_TEXT_RE, "[url]");
}

function blankToUndefined(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return value;
}
