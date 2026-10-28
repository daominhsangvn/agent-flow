import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import type { Result } from "@repo/api/src/types/result";
import {
  HttpMethod,
  type IntegrationAccount,
  type ValidateConnectionReason,
  type ValidateConnectionResult,
} from "../../types";
import { fetchAtlassianCloudId } from "../atlassian/auth";
import {
  type ConfluenceContext,
  type ConfluenceError,
  ConfluenceErrorKind,
  confluenceRequest,
} from "./client";
import {
  type ConfluenceConnectionConfig,
  confluenceCurrentUserSchema,
} from "./schemas";

/**
 * A Confluence Cloud connection is a site plus the email and API token of
 * the bot account (the same kind of token as Jira Cloud). The account of
 * `/user/current` is the bot whose comments are marked `mine`. A token the
 * site rejects is tried once more through the Atlassian API gateway, where
 * API tokens with scopes work; the cloud id is then saved with the config.
 */

export const CONFLUENCE_CONNECTION_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "siteUrl",
    label: "Site URL",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://your-company.atlassian.net",
    description: "Base URL of the Confluence Cloud site (without /wiki).",
  },
  {
    key: "email",
    label: "Bot account email",
    kind: IntegrationFieldKind.Email,
    required: true,
    placeholder: "agentflow-bot@your-company.com",
    description:
      "Email address of the Atlassian account that reads and writes pages and comments.",
  },
  {
    key: "apiToken",
    label: "API token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description:
      "An API token of the bot account (id.atlassian.com > Security > API tokens): a token without scopes, or a token with scopes (app Confluence) that has read:confluence-user, read:page:confluence, write:page:confluence, read:comment:confluence, write:comment:confluence, read:space:confluence and search:confluence. The bot needs to view, add pages and comment in the project's spaces.",
  },
];

/** Changing the site requires the token to be entered again. */
export const CONFLUENCE_CREDENTIAL_ORIGIN_FIELDS: Array<
  keyof ConfluenceConnectionConfig
> = ["siteUrl"];

/** Identifies the bot with `GET /user/current`; no side effects. */
export async function validateConfluenceConnection(
  ctx: ConfluenceContext,
  _reason: ValidateConnectionReason
): Promise<ValidateConnectionResult<ConfluenceConnectionConfig>> {
  // The gateway is never taken from the submitted config: it is re-detected.
  const siteConfig: ConfluenceConnectionConfig = {
    ...ctx.connection.config,
    cloudId: null,
  };
  const direct = await currentUser(ctx, siteConfig);
  if (direct.ok) {
    return identified(siteConfig, direct.value);
  }
  if (direct.error.kind !== ConfluenceErrorKind.Unauthorized) {
    return { ok: false, error: describeError(direct.error, siteConfig) };
  }
  const cloudId = await fetchAtlassianCloudId(ctx.http, siteConfig.siteUrl);
  if (!cloudId) {
    return { ok: false, error: direct.error.message };
  }
  const gatewayConfig = { ...siteConfig, cloudId };
  const viaGateway = await currentUser(ctx, gatewayConfig);
  if (!viaGateway.ok) {
    return { ok: false, error: describeError(viaGateway.error, gatewayConfig) };
  }
  ctx.log.info("Confluence token works through the Atlassian API gateway", {
    connectionId: ctx.connection.id,
  });
  return identified(gatewayConfig, viaGateway.value);
}

type CurrentUser = { accountId: string; displayName: string | null };

function currentUser(
  ctx: ConfluenceContext,
  config: ConfluenceConnectionConfig
): Promise<Result<CurrentUser | null, ConfluenceError>> {
  return confluenceRequest(
    { ...ctx, connection: { ...ctx.connection, config } },
    { method: HttpMethod.Get, path: "rest/api/user/current" },
    confluenceCurrentUserSchema.transform((user) =>
      user.accountId && user.type !== ANONYMOUS
        ? { accountId: user.accountId, displayName: user.displayName ?? null }
        : null
    )
  );
}

const ANONYMOUS = "anonymous";

function identified(
  config: ConfluenceConnectionConfig,
  user: CurrentUser | null
): ValidateConnectionResult<ConfluenceConnectionConfig> {
  if (!user) {
    return {
      ok: false,
      error:
        "Confluence answered as an anonymous user. Check the bot account's email address and API token.",
    };
  }
  const account: IntegrationAccount = {
    externalAccountId: user.accountId,
    displayName: user.displayName ?? config.email,
    aliases: [config.email],
    details: { siteUrl: config.siteUrl },
  };
  return { ok: true, account, config };
}

function describeError(
  error: ConfluenceError,
  config: ConfluenceConnectionConfig
): string {
  if (error.kind === ConfluenceErrorKind.NotFound) {
    return `No Confluence was found at ${config.siteUrl}/wiki. Check the site URL.`;
  }
  if (error.kind === ConfluenceErrorKind.Unavailable && error.status === 0) {
    return `Could not reach Confluence at ${config.siteUrl}. Check the site URL and that this server can reach it.`;
  }
  return error.message;
}
