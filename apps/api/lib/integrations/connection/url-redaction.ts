import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";

/**
 * Config values as org members see them. Outbound URLs (webhook targets,
 * callback URLs) often carry their credential in the path or query, so a
 * member who is not an org admin sees only the origin of every field of kind
 * "url" ("https://hooks.example.com/…"). Admins, who edit the values, see
 * them in full. Used by the connection and workflow read endpoints.
 */

/** Who reads a DTO; decided by the route with getOrgAdminStatus. */
export type ConfigViewer = { isAdmin: boolean };

/** Admin-only paths (create/update responses) read as an admin. */
export const ADMIN_VIEWER: ConfigViewer = { isAdmin: true };

/**
 * The config for this viewer: unchanged for admins; for other members every
 * url-kind field reduced to its origin. Without field descriptors (the
 * provider or definition is no longer registered) a member gets nothing.
 */
export function redactUrlFields(
  config: JsonObject,
  fields: readonly IntegrationFieldDescriptor[] | null,
  viewer: ConfigViewer
): JsonObject {
  if (viewer.isAdmin) {
    return config;
  }
  if (!fields) {
    return {};
  }
  const urlKeys = new Set(
    fields
      .filter((field) => field.kind === IntegrationFieldKind.Url)
      .map((field) => field.key)
  );
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      urlKeys.has(key) ? redactUrlValue(value) : value,
    ])
  );
}

/**
 * The origin of a URL, followed by "/…" when the URL has anything after it
 * (path, query or fragment). User info is never kept. Anything that is not
 * an http(s) URL becomes "…".
 */
export function toUrlOrigin(value: string): string {
  if (!URL.canParse(value)) {
    return REDACTED_URL;
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return REDACTED_URL;
  }
  const bare = url.pathname === "/" && url.search === "" && url.hash === "";
  return bare ? url.origin : `${url.origin}/${REDACTED_URL}`;
}

const REDACTED_URL = "…";

function redactUrlValue(value: JsonValue): JsonValue {
  if (typeof value !== "string" || value === "") {
    return value;
  }
  return toUrlOrigin(value);
}
