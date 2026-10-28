import { z } from "zod";
import { HttpMethod, type ProviderHttp } from "../../types";

/**
 * What Jira Cloud and Confluence Cloud share: the bot account's API token as
 * `Basic base64(email:token)`, and the Atlassian API gateway
 * (`https://api.atlassian.com/ex/{product}/{cloudId}`), the only place an API
 * token with scopes works. The site's cloud id comes from
 * `/_edge/tenant_info`, which needs no authentication.
 */

export const ATLASSIAN_API_GATEWAY_ORIGIN = "https://api.atlassian.com/ex";

/** A Cloud site id, as `/_edge/tenant_info` returns it. */
export const ATLASSIAN_CLOUD_ID_RE =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const AtlassianProduct = {
  Jira: "jira",
  Confluence: "confluence",
} as const;
export type AtlassianProduct =
  (typeof AtlassianProduct)[keyof typeof AtlassianProduct];

export function atlassianBasicAuthorization(
  email: string,
  apiToken: string
): string {
  const credentials = `${email}:${apiToken}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

/** `https://api.atlassian.com/ex/{product}/{cloudId}`. */
export function atlassianGatewayUrl(
  product: AtlassianProduct,
  cloudId: string
): string {
  return `${ATLASSIAN_API_GATEWAY_ORIGIN}/${product}/${cloudId}`;
}

/** The Cloud site's id (`/_edge/tenant_info`, no authentication), or null. */
export async function fetchAtlassianCloudId(
  http: ProviderHttp,
  siteUrl: string
): Promise<string | null> {
  const response = await http.request({
    method: HttpMethod.Get,
    url: `${siteUrl}/_edge/tenant_info`,
    followRedirects: false,
  });
  const parsed = tenantInfoSchema.safeParse(response.json);
  return response.ok && parsed.success ? parsed.data.cloudId : null;
}

/** `GET {site}/_edge/tenant_info`. */
const tenantInfoSchema = z.looseObject({
  cloudId: z
    .string()
    .trim()
    .regex(ATLASSIAN_CLOUD_ID_RE)
    .transform((value) => value.toLowerCase()),
});
