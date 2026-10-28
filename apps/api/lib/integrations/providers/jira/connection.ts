import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import {
  HttpMethod,
  type ValidateConnectionReason,
  type ValidateConnectionResult,
} from "../../types";
import { fetchAtlassianCloudId } from "../atlassian/auth";
import {
  type JiraContext,
  type JiraError,
  JiraErrorKind,
  jiraRequest,
} from "./client";
import { JiraDeployment } from "./constants";
import { accountFromMyself } from "./identity";
import {
  type JiraConnectionConfig,
  type JiraUser,
  jiraUserSchema,
} from "./schemas";

/**
 * A Jira connection is a site plus the credentials of the bot account:
 * Cloud uses the bot's email and an API token (Basic auth), Data Center a
 * personal access token (Bearer). The account returned by `/myself` is the
 * bot that triggers watch for and that posts comments. A Cloud token the
 * site rejects is tried once more through the Atlassian API gateway, where
 * API tokens with scopes work; the site's cloud id is then saved with the
 * config so every later call goes there.
 */

export const JIRA_CONNECTION_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "deployment",
    label: "Deployment",
    kind: IntegrationFieldKind.Select,
    required: true,
    defaultValue: JiraDeployment.Cloud,
    options: [
      { value: JiraDeployment.Cloud, label: "Jira Cloud" },
      { value: JiraDeployment.DataCenter, label: "Jira Data Center / Server" },
    ],
  },
  {
    key: "siteUrl",
    label: "Site URL",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://your-company.atlassian.net",
    description:
      "Base URL of the Jira site. Data Center sites may include a context path, e.g. https://jira.example.com/jira.",
  },
  {
    key: "email",
    label: "Bot account email",
    kind: IntegrationFieldKind.Email,
    required: true,
    placeholder: "agentflow-bot@your-company.com",
    description:
      "Email address of the Jira account the workflows react to (issues assigned to it start runs) and that posts comments.",
    showWhen: { field: "deployment", equals: JiraDeployment.Cloud },
  },
  {
    key: "apiToken",
    label: "API token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description:
      "Jira Cloud: an API token of the bot account (id.atlassian.com > Security > API tokens). Both kinds work: a token without scopes, or a token with scopes (app Jira) that has read:jira-user, read:jira-work and write:jira-work. Data Center: a personal access token of the bot account (Profile > Personal Access Tokens). The bot needs Browse projects, Add comments and Transition issues permissions.",
  },
];

/** Identifies the bot with `GET /myself`; no side effects for either reason. */
export async function validateJiraConnection(
  ctx: JiraContext,
  _reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<JiraConnectionConfig>> {
  // The gateway is never taken from the submitted config: it is re-detected.
  const { cloudId: _submitted, ...siteConfig } = ctx.connection.config;
  const identified = await identifyBot(ctx, siteConfig);
  if (!identified.ok) {
    return { ok: false, error: identified.error };
  }
  const { config, myself } = identified.value;
  if (myself.active === false) {
    return {
      ok: false,
      error: "The Jira account of these credentials is deactivated.",
    };
  }
  const account = accountFromMyself(myself, config.deployment);
  if (!account) {
    return { ok: false, error: deploymentMismatchError(config.deployment) };
  }
  return { ok: true, account, config };
}

type IdentifiedBot = { config: JiraConnectionConfig; myself: JiraUser };

/**
 * `/myself` against the site; for a Cloud token the site rejects (401),
 * once more through the API gateway, which is where an API token with
 * scopes works. The returned config is the one that worked.
 */
async function identifyBot(
  ctx: JiraContext,
  siteConfig: JiraConnectionConfig
): Promise<Result<IdentifiedBot, string>> {
  const direct = await requestMyself(ctx, siteConfig);
  if (direct.ok) {
    return Result.ok({ config: siteConfig, myself: direct.value });
  }
  const siteError = describeValidationError(direct.error, siteConfig);
  if (
    siteConfig.deployment !== JiraDeployment.Cloud ||
    direct.error.kind !== JiraErrorKind.Unauthorized
  ) {
    return Result.err(siteError);
  }
  const cloudId = await fetchAtlassianCloudId(ctx.http, siteConfig.siteUrl);
  if (!cloudId) {
    return Result.err(siteError);
  }
  const gatewayConfig: JiraConnectionConfig = { ...siteConfig, cloudId };
  const viaGateway = await requestMyself(ctx, gatewayConfig);
  if (!viaGateway.ok) {
    return Result.err(
      viaGateway.error.kind === JiraErrorKind.Unauthorized
        ? siteError
        : describeValidationError(viaGateway.error, gatewayConfig)
    );
  }
  ctx.log.info("Jira token works through the Atlassian API gateway", {
    connectionId: ctx.connection.id,
  });
  return Result.ok({ config: gatewayConfig, myself: viaGateway.value });
}

function requestMyself(
  ctx: JiraContext,
  config: JiraConnectionConfig
): Promise<Result<JiraUser, JiraError>> {
  return jiraRequest(
    { ...ctx, connection: { ...ctx.connection, config } },
    { method: HttpMethod.Get, path: "myself" },
    jiraUserSchema
  );
}

function describeValidationError(
  error: JiraError,
  config: JiraConnectionConfig
): string {
  if (error.kind === JiraErrorKind.NotFound) {
    return `No Jira REST API was found at ${config.siteUrl}. Check the site URL and the deployment type.`;
  }
  if (error.kind === JiraErrorKind.Unavailable && error.status === 0) {
    return `Could not reach Jira at ${config.siteUrl}. Check the site URL and that this server can reach it.`;
  }
  return error.message;
}

function deploymentMismatchError(deployment: JiraDeployment): string {
  return deployment === JiraDeployment.Cloud
    ? "Jira did not return an Atlassian account id. If this is Jira Data Center or Server, choose that deployment."
    : "Jira did not return a user key or name. If this is Jira Cloud, choose that deployment.";
}

/**
 * Config fields that decide where the API token is sent: changing one
 * requires the token to be entered again (credentialOriginFields).
 */
export const JIRA_CREDENTIAL_ORIGIN_FIELDS: Array<keyof JiraConnectionConfig> =
  ["siteUrl", "deployment"];
