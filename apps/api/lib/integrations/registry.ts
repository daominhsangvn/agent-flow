import {
  IntegrationCapability,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import { azureDevOpsProvider } from "./providers/azure-devops/provider";
import { bitbucketProvider } from "./providers/bitbucket/provider";
import { githubProvider } from "./providers/github/provider";
import { jiraProvider } from "./providers/jira/provider";
import { localGitProvider } from "./providers/local-git/provider";
import { microsoftTeamsProvider } from "./providers/microsoft-teams/provider";
import { webhookProvider } from "./providers/webhook/provider";
import type {
  IntegrationActionDefinition,
  IntegrationProviderDefinition,
  IntegrationTriggerDefinition,
} from "./types";

// biome-ignore lint/suspicious/noExplicitAny: providers have heterogeneous config types
export type AnyProvider = IntegrationProviderDefinition<any, any>;

/**
 * The only place integration providers are listed. Everything else (routes,
 * workflow engine, UI catalog) discovers providers, triggers and actions
 * through the lookups below. To add an integration, implement
 * IntegrationProviderDefinition under ./providers/<key>/ and append it here.
 */
const PROVIDERS: readonly AnyProvider[] = [
  jiraProvider,
  azureDevOpsProvider,
  githubProvider,
  bitbucketProvider,
  localGitProvider,
  microsoftTeamsProvider,
  webhookProvider,
];

const providersByKey = new Map<string, AnyProvider>(
  PROVIDERS.map((provider) => [provider.key, provider])
);

export function listIntegrationProviders(): readonly AnyProvider[] {
  return PROVIDERS;
}

export function getIntegrationProvider(key: string): AnyProvider | null {
  return providersByKey.get(key) ?? null;
}

export function findTriggerDefinition(
  providerKey: string,
  triggerType: string
): IntegrationTriggerDefinition<unknown> | null {
  const provider = getIntegrationProvider(providerKey);
  return (
    provider?.triggers.find((trigger) => trigger.key === triggerType) ?? null
  );
}

export function findActionDefinition(
  providerKey: string,
  actionType: string
): IntegrationActionDefinition<unknown> | null {
  const provider = getIntegrationProvider(providerKey);
  return provider?.actions.find((action) => action.key === actionType) ?? null;
}

/** Wire shape of a provider for GET /integrations/providers. */
export function toProviderSummary(
  provider: AnyProvider
): IntegrationProviderSummary {
  return {
    key: provider.key,
    displayName: provider.displayName,
    description: provider.description,
    docsUrl: provider.docsUrl ?? null,
    connectionFields: provider.connection.fields,
    credentialOriginFields: provider.connection.credentialOriginFields ?? [],
    deliveryModes: provider.inbound?.deliveryModes ?? [],
    capabilities: providerCapabilities(provider),
    builtIn: provider.builtIn === true,
    triggers: provider.triggers.map((trigger) => ({
      key: trigger.key,
      displayName: trigger.displayName,
      description: trigger.description,
      configFields: trigger.configFields,
      manualRun:
        trigger.manualRun && provider.source?.resolveManual
          ? trigger.manualRun
          : null,
    })),
    actions: provider.actions.map((action) => ({
      key: action.key,
      displayName: action.displayName,
      description: action.description,
      configFields: action.configFields,
      defaultEvents: action.defaultEvents,
    })),
  };
}

function providerCapabilities(provider: AnyProvider): IntegrationCapability[] {
  const capabilities: IntegrationCapability[] = [];
  if (provider.triggers.length > 0) {
    capabilities.push(IntegrationCapability.Triggers);
  }
  if (provider.actions.length > 0) {
    capabilities.push(IntegrationCapability.Actions);
  }
  if (provider.repositories) {
    capabilities.push(IntegrationCapability.Repositories);
  }
  if (provider.repositories?.create) {
    capabilities.push(IntegrationCapability.RepositoryCreation);
  }
  return capabilities;
}
