import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { definePullRequestAction } from "../../pull-request-action";
import { defineIntegrationProvider } from "../../types";
import { addCommentAction, updateStateAction } from "./actions";
import {
  ADO_CREDENTIAL_ORIGIN_FIELDS,
  adoConnectionFields,
  validateAdoConnection,
} from "./connection";
import { AzureDevOpsActionType } from "./constants";
import {
  adoSetupInstructions,
  parseAdoInbound,
  verifyAdoInbound,
} from "./inbound";
import { runPipelineAction } from "./pipeline-action";
import { pollAzureDevOps } from "./poll";
import { adoRepositories } from "./repositories";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoConnectionConfigSchema,
  adoSecretsSchema,
} from "./schemas";
import { fetchAdoSourceItem, resolveAdoManualEvent } from "./source";
import {
  workItemAssignedTrigger,
  workItemMentionedTrigger,
  workItemTaggedTrigger,
} from "./triggers";

/**
 * Azure DevOps Services: work items assigned to the bot account (the owner of
 * the connection's PAT), tagged, or mentioning the bot start workflows; pre and post actions
 * comment on the work item, change its state, open pull requests and run
 * pipelines (never on their own: only the actions an admin adds to a workflow
 * write to Azure DevOps). Projects add Azure Repos repositories from the
 * connection. Events arrive through service hooks (webhook) or WIQL polling.
 */
export const azureDevOpsProvider = defineIntegrationProvider<
  AdoConnectionConfig,
  AdoSecrets
>({
  key: IntegrationProviderKey.AzureDevOps,
  displayName: "Azure DevOps",
  description:
    "Start workflows when an Azure DevOps work item is assigned to the bot account or tagged, work on Azure Repos repositories, then comment on the work item, change its state, open pull requests or run pipelines as the run progresses.",
  docsUrl:
    "https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks",
  connection: {
    configSchema: adoConnectionConfigSchema,
    secretsSchema: adoSecretsSchema,
    fields: adoConnectionFields,
    credentialOriginFields: ADO_CREDENTIAL_ORIGIN_FIELDS,
    validate: (ctx) => validateAdoConnection(ctx),
  },
  inbound: {
    deliveryModes: [
      IntegrationDeliveryMode.Webhook,
      IntegrationDeliveryMode.Poll,
    ],
    setupInstructions: adoSetupInstructions,
    verify: verifyAdoInbound,
    parse: parseAdoInbound,
    poll: pollAzureDevOps,
  },
  source: {
    fetchItem: fetchAdoSourceItem,
    resolveManual: resolveAdoManualEvent,
  },
  triggers: [
    workItemAssignedTrigger,
    workItemTaggedTrigger,
    workItemMentionedTrigger,
  ],
  actions: [
    addCommentAction,
    updateStateAction,
    definePullRequestAction({
      key: AzureDevOpsActionType.CreatePullRequest,
      providerName: "Azure DevOps",
      repositories: adoRepositories,
    }),
    runPipelineAction,
  ],
  repositories: adoRepositories,
});
