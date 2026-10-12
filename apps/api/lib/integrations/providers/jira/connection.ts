import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import {
  HttpMethod,
  type ValidateConnectionReason,
  type ValidateConnectionResult,
} from "../../types";
import {
  type JiraContext,
  type JiraError,
  JiraErrorKind,
  jiraRequest,
} from "./client";
import { JiraDeployment } from "./constants";
import { accountFromMyself } from "./identity";
import { type JiraConnectionConfig, jiraUserSchema } from "./schemas";

/**
 * A Jira connection is a site plus the credentials of the bot account:
 * Cloud uses the bot's email and a classic API token (Basic auth), Data
 * Center a personal access token (Bearer). The account returned by
 * `/myself` is the bot that triggers watch for and that posts comments.
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
      "Jira Cloud: a classic API token of the bot account (id.atlassian.com > Security > API tokens; scoped tokens are not supported). Data Center: a personal access token of the bot account (Profile > Personal Access Tokens). The bot needs Browse projects, Add comments and Transition issues permissions.",
  },
];

/** Identifies the bot with `GET /myself`; no side effects for either reason. */
export async function validateJiraConnection(
  ctx: JiraContext,
  _reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<JiraConnectionConfig>> {
  const config = ctx.connection.config;
  const myself = await jiraRequest(
    ctx,
    { method: HttpMethod.Get, path: "myself" },
    jiraUserSchema
  );
  if (!myself.ok) {
    return { ok: false, error: describeValidationError(myself.error, config) };
  }
  if (myself.value.active === false) {
    return {
      ok: false,
      error: "The Jira account of these credentials is deactivated.",
    };
  }
  const account = accountFromMyself(myself.value, config.deployment);
  if (!account) {
    return { ok: false, error: deploymentMismatchError(config.deployment) };
  }
  return { ok: true, account, config };
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
