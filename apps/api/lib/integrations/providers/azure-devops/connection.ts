import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import {
  HttpMethod,
  type IntegrationAccount,
  type ValidateConnectionResult,
} from "../../types";
import {
  ADO_API_VERSION,
  ADO_TOKEN_REJECTED_MESSAGE,
  type AdoContext,
  AdoErrorKind,
  adoRequest,
} from "./client";
import {
  type AdoConnectionConfig,
  type AdoConnectionData,
  adoConnectionDataSchema,
  adoWiqlResultSchema,
  normalizeOrganizationUrl,
  ORGANIZATION_URL_HINT,
  organizationNameFromUrl,
} from "./schemas";

/**
 * Connection form and credential check. The PAT owner is the "bot": work
 * items assigned to it trigger workflows, and everything the provider writes
 * (comments, state changes) is authored by it.
 */

export const adoConnectionFields: IntegrationFieldDescriptor[] = [
  {
    key: "organizationUrl",
    label: "Organization URL",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://dev.azure.com/contoso",
    description:
      "Your Azure DevOps organization, e.g. https://dev.azure.com/contoso or https://contoso.visualstudio.com.",
  },
  {
    key: "pat",
    label: "Personal access token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description:
      "Organization-scoped personal access token of the bot account, with the Work Items (Read & write) scope, plus Code (Read & write) to work on Azure Repos repositories and Build (Read & execute) to run pipelines. Work items assigned to this account start workflows, and comments and pull requests are created as this account. Global PATs stop working on December 1, 2026.",
  },
];

export async function validateAdoConnection(
  ctx: AdoContext
): Promise<ValidateConnectionResult<AdoConnectionConfig>> {
  const organizationUrl = normalizeOrganizationUrl(
    ctx.connection.config.organizationUrl
  );
  if (!organizationUrl) {
    return { ok: false, error: ORGANIZATION_URL_HINT };
  }
  const config: AdoConnectionConfig = { organizationUrl };
  const scopedCtx: AdoContext = {
    ...ctx,
    connection: { ...ctx.connection, config },
  };

  const connectionData = await adoRequest(
    scopedCtx,
    {
      method: HttpMethod.Get,
      path: "_apis/connectionData",
      query: { connectOptions: "none", lastChangeId: -1, lastChangeId64: -1 },
    },
    adoConnectionDataSchema
  );
  if (!connectionData.ok) {
    return {
      ok: false,
      error: describeConnectionError(
        connectionData.error.kind,
        connectionData.error.message,
        organizationUrl
      ),
    };
  }
  // connectionData answers anonymous callers with a placeholder identity.
  if (ANONYMOUS_IDENTITY_RE.test(connectionData.value.authenticatedUser.id)) {
    return { ok: false, error: ADO_TOKEN_REJECTED_MESSAGE };
  }

  const scopeCheck = await checkWorkItemAccess(scopedCtx);
  if (scopeCheck) {
    return { ok: false, error: scopeCheck };
  }

  return {
    ok: true,
    account: toIntegrationAccount(connectionData.value, organizationUrl),
    config,
  };
}

const ANONYMOUS_IDENTITY_RE = /^a{8}-a{4}-a{4}-a{4}-a{12}$/i;
const WORK_ITEM_ACCESS_QUERY =
  "SELECT [System.Id] FROM WorkItems WHERE [System.Id] < 0";

/** Runs an empty WIQL query so a token without the Work Items scope fails at save time. */
async function checkWorkItemAccess(ctx: AdoContext): Promise<string | null> {
  const result = await adoRequest(
    ctx,
    {
      method: HttpMethod.Post,
      path: "_apis/wit/wiql",
      query: { "api-version": ADO_API_VERSION, $top: 1 },
      body: { query: WORK_ITEM_ACCESS_QUERY },
    },
    adoWiqlResultSchema
  );
  if (result.ok) {
    return null;
  }
  const { kind, message } = result.error;
  if (kind === AdoErrorKind.Unauthorized || kind === AdoErrorKind.Forbidden) {
    return "The personal access token cannot read work items. Grant it the Work Items (Read & write) scope.";
  }
  return message;
}

function describeConnectionError(
  kind: AdoErrorKind,
  message: string,
  organizationUrl: string
): string {
  if (kind === AdoErrorKind.NotFound) {
    return `No Azure DevOps organization found at ${organizationUrl}`;
  }
  return message;
}

function toIntegrationAccount(
  data: AdoConnectionData,
  organizationUrl: string
): IntegrationAccount {
  const user = data.authenticatedUser;
  const aliases = [
    user.properties?.Account?.$value,
    user.subjectDescriptor,
  ].filter((alias): alias is string => Boolean(alias?.trim()));
  return {
    externalAccountId: user.id,
    displayName:
      user.providerDisplayName?.trim() ||
      user.customDisplayName?.trim() ||
      null,
    aliases: [...new Set(aliases.map((alias) => alias.trim()))],
    details: {
      organization: organizationNameFromUrl(organizationUrl),
      organizationUrl,
    },
  };
}

/**
 * Config fields that decide where the PAT is sent: changing one requires the
 * PAT to be entered again (credentialOriginFields).
 */
export const ADO_CREDENTIAL_ORIGIN_FIELDS: Array<keyof AdoConnectionConfig> = [
  "organizationUrl",
];
