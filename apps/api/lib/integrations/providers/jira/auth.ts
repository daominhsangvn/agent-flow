import { JiraDeployment } from "./constants";
import type { JiraConnectionConfig, JiraSecrets } from "./schemas";

/**
 * Credentials and REST base per deployment:
 * - Cloud: classic API token of the bot account, `Basic base64(email:token)`,
 *   REST v3 (rich text as ADF).
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
    const credentials = `${config.email ?? ""}:${secrets.apiToken}`;
    return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }
  return `Bearer ${secrets.apiToken}`;
}

export function jiraRestVersion(deployment: JiraDeployment): JiraRestVersion {
  return deployment === JiraDeployment.Cloud
    ? JiraRestVersion.Cloud
    : JiraRestVersion.DataCenter;
}

/** `{siteUrl}/rest/api/{3|2}` without a trailing slash. */
export function jiraRestBaseUrl(config: JiraConnectionConfig): string {
  return `${config.siteUrl}/rest/api/${jiraRestVersion(config.deployment)}`;
}
