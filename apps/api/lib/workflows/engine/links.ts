import { getRoutePrefixForType } from "@repo/api/src/types/document";

/**
 * Absolute links into the web app used in post-action messages:
 * `{NEXT_PUBLIC_APP_URL}/{orgSlug}/workflows/{workflowId}/runs/{runId}`,
 * `/{orgSlug}/issues/{slug}`, `/{orgSlug}/implementation-plans/{slug}` and
 * the page of any routable document type (`/{orgSlug}/prds/{slug}`, ...).
 */

const DEFAULT_APP_URL = "http://localhost:3000";
const TRAILING_SLASHES_RE = /\/+$/;

export function appBaseUrl(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.BETTER_AUTH_URL,
  ];
  const base =
    candidates.find((value) => value !== undefined && value.trim() !== "") ??
    DEFAULT_APP_URL;
  return base.trim().replace(TRAILING_SLASHES_RE, "");
}

export function workflowRunUrl(
  orgSlug: string,
  workflowId: string,
  runId: string
): string {
  return `${orgPrefix(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`;
}

export function issueUrl(orgSlug: string, slug: string): string {
  return `${orgPrefix(orgSlug)}/issues/${encodeURIComponent(slug)}`;
}

export function implementationPlanUrl(orgSlug: string, slug: string): string {
  return `${orgPrefix(orgSlug)}/implementation-plans/${encodeURIComponent(slug)}`;
}

/** Page of a document by its type, or null for a type without one. */
export function documentPageUrl(
  orgSlug: string,
  type: string,
  slug: string
): string | null {
  const prefix = getRoutePrefixForType(type);
  return prefix
    ? `${orgPrefix(orgSlug)}/${prefix}/${encodeURIComponent(slug)}`
    : null;
}

function orgPrefix(orgSlug: string): string {
  return `${appBaseUrl()}/${encodeURIComponent(orgSlug)}`;
}
