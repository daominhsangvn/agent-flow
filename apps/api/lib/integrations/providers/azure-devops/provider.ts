import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { definePullRequestAction } from "../../pull-request-action";
import { conditionsReviewSignal } from "../../trigger-conditions";
import { defineIntegrationProvider } from "../../types";
import { addCommentAction, updateStateAction } from "./actions";
import {
  ADO_CREDENTIAL_ORIGIN_FIELDS,
  adoConnectionFields,
  validateAdoConnection,
} from "./connection";
import {
  AdoEventAttribute,
  AzureDevOpsActionType,
  AzureDevOpsTriggerType,
} from "./constants";
import {
  adoSetupInstructions,
  parseAdoInbound,
  verifyAdoInbound,
} from "./inbound";
import { addLinkAction, updateTagsAction } from "./item-actions";
import { runPipelineAction } from "./pipeline-action";
import { pollAzureDevOps } from "./poll";
import { adoProjectDefinition } from "./project";
import { adoRepositories } from "./repositories";
import {
  type AdoConnectionConfig,
  type AdoSecrets,
  adoConnectionConfigSchema,
  adoSecretsSchema,
} from "./schemas";
import {
  fetchAdoSourceItem,
  parseAdoItemReference,
  resolveAdoManualEvent,
} from "./source";
import {
  workItemAssignedTrigger,
  workItemConditionsTrigger,
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
    "Start workflows when an Azure DevOps work item is assigned to the bot account, tagged or mentions the bot (alone or combined), work on Azure Repos repositories, then comment on the work item, change its state, open pull requests or run pipelines as the run progresses.",
  docsUrl:
    "https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks",
  connection: {
    configSchema: adoConnectionConfigSchema,
    secretsSchema: adoSecretsSchema,
    fields: adoConnectionFields,
    credentialOriginFields: ADO_CREDENTIAL_ORIGIN_FIELDS,
    validate: (ctx) => validateAdoConnection(ctx),
  },
  project: adoProjectDefinition,
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
    parseItemReference: parseAdoItemReference,
  },
  reviewSignal: conditionsReviewSignal({
    triggerType: AzureDevOpsTriggerType.WorkItemConditions,
    addedLabelsAttribute: AdoEventAttribute.AddedTags,
    mentionedAttribute: AdoEventAttribute.Mentioned,
  }),
  triggers: [
    workItemAssignedTrigger,
    workItemTaggedTrigger,
    workItemMentionedTrigger,
    workItemConditionsTrigger,
  ],
  actions: [
    addCommentAction,
    updateStateAction,
    updateTagsAction,
    addLinkAction,
    definePullRequestAction({
      key: AzureDevOpsActionType.CreatePullRequest,
      providerName: "Azure DevOps",
      repositories: adoRepositories,
    }),
    runPipelineAction,
  ],
  repositories: adoRepositories,
});
