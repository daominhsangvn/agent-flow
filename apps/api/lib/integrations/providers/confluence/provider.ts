import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { defineIntegrationProvider } from "../../types";
import { CONFLUENCE_ACTIONS } from "./actions";
import {
  CONFLUENCE_CONNECTION_FIELDS,
  CONFLUENCE_CREDENTIAL_ORIGIN_FIELDS,
  validateConfluenceConnection,
} from "./connection";
import { confluenceProjectDefinition } from "./project";
import { CONFLUENCE_READS } from "./reads";
import {
  type ConfluenceConnectionConfig,
  type ConfluenceSecrets,
  confluenceConnectionConfigSchema,
  confluenceSecretsSchema,
} from "./schemas";

/**
 * Confluence Cloud, for agents and actions that publish and review
 * documents: read pages and their comments, create and update pages,
 * comment, and resolve inline comments, only in the spaces of the project
 * connection. Nothing starts a run from Confluence. See docs/workflows.md
 * "Confluence".
 */
export const confluenceProvider = defineIntegrationProvider<
  ConfluenceConnectionConfig,
  ConfluenceSecrets
>({
  key: IntegrationProviderKey.Confluence,
  displayName: "Confluence",
  description:
    "Let agents and workflow actions read, create and update Confluence Cloud pages and answer their comments, within the spaces of each project.",
  docsUrl: "https://developer.atlassian.com/cloud/confluence/rest/v2/intro/",
  connection: {
    configSchema: confluenceConnectionConfigSchema,
    secretsSchema: confluenceSecretsSchema,
    fields: CONFLUENCE_CONNECTION_FIELDS,
    credentialOriginFields: CONFLUENCE_CREDENTIAL_ORIGIN_FIELDS,
    validate: validateConfluenceConnection,
  },
  project: confluenceProjectDefinition,
  triggers: [],
  actions: CONFLUENCE_ACTIONS,
  reads: CONFLUENCE_READS,
});
