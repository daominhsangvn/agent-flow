import {
  AtlassianProduct,
  atlassianBasicAuthorization,
  atlassianGatewayUrl,
} from "../atlassian/auth";
import { JiraDeployment } from "./constants";
import type { JiraConnectionConfig, JiraSecrets } from "./schemas";

/**
 * Credentials and REST base per deployment:
 * - Cloud: API token of the bot account, `Basic base64(email:token)`, REST v3
 *   (rich text as ADF). A classic token works against the site URL; a token
 *   with scopes only through the Atlassian API gateway
 *   (`https://api.atlassian.com/ex/jira/{cloudId}`), which validation
 *   detects and records as `cloudId`.
 * - Data Center / Server 8.14+: personal access token as `Bearer`, REST v2.
 */

export const JiraRestVersion = {
  Cloud: "3",
  DataCenter: "2",
} as const;
export type JiraRestVersion =
  (typeof JiraRestVersion)[keyof typeof JiraRestVersion];

export function buildJiraAuthorization(
  config: JiraConnectionConfig,
  secrets: JiraSecrets
): string {
  if (config.deployment === JiraDeployment.Cloud) {
    return atlassianBasicAuthorization(config.email ?? "", secrets.apiToken);
  }
  return `Bearer ${secrets.apiToken}`;
}

export function jiraRestVersion(deployment: JiraDeployment): JiraRestVersion {
  return deployment === JiraDeployment.Cloud
    ? JiraRestVersion.Cloud
    : JiraRestVersion.DataCenter;
}

/**
 * `{siteUrl}/rest/api/{3|2}`, or the API gateway's
 * `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3` for a Cloud token
 * with scopes; without a trailing slash.
 */
export function jiraRestBaseUrl(config: JiraConnectionConfig): string {
  const version = jiraRestVersion(config.deployment);
  if (config.deployment === JiraDeployment.Cloud && config.cloudId) {
    return `${atlassianGatewayUrl(AtlassianProduct.Jira, config.cloudId)}/rest/api/${version}`;
  }
  return `${config.siteUrl}/rest/api/${version}`;
}
