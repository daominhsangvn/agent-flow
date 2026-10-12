import {
  type IntegrationActionSummary,
  type IntegrationConnection,
  IntegrationProviderKey,
  type IntegrationProviderSummary,
  type IntegrationTriggerSummary,
} from "@repo/api/src/types/integration";
import type { WorkflowTrigger } from "@repo/api/src/types/workflow";

/**
 * Lookups over the provider catalog (`GET /integrations/providers`) and the
 * org's connections. The workflow editor never hardcodes a trigger or action:
 * everything it offers comes through these helpers.
 */

export function findProvider(
  providers: readonly IntegrationProviderSummary[],
  providerKey: string
): IntegrationProviderSummary | undefined {
  return providers.find((provider) => provider.key === providerKey);
}

/** The provider of a connection, or undefined when the connection or provider is unknown. */
export function findConnectionProvider(
  providers: readonly IntegrationProviderSummary[],
  connections: readonly IntegrationConnection[],
  connectionId: string
): IntegrationProviderSummary | undefined {
  if (connectionId === BUILT_IN_HTTP_CONNECTION) {
    return findProvider(providers, IntegrationProviderKey.Webhook);
  }
  const connection = connections.find(
    (candidate) => candidate.id === connectionId
  );
  return connection ? findProvider(providers, connection.provider) : undefined;
}

/** The trigger definition for a trigger type key, searched across every provider. */
export function findTriggerDefinition(
  providers: readonly IntegrationProviderSummary[],
  type: string
): IntegrationTriggerSummary | undefined {
  for (const provider of providers) {
    const trigger = provider.triggers.find(
      (candidate) => candidate.key === type
    );
    if (trigger) {
      return trigger;
    }
  }
  return undefined;
}

/** The action definition for an action type key, searched across every provider. */
export function findActionDefinition(
  providers: readonly IntegrationProviderSummary[],
  type: string
): IntegrationActionSummary | undefined {
  for (const provider of providers) {
    const action = provider.actions.find((candidate) => candidate.key === type);
    if (action) {
      return action;
    }
  }
  return undefined;
}

/** Connections whose provider offers at least one trigger. */
export function getTriggerConnections(
  providers: readonly IntegrationProviderSummary[],
  connections: readonly IntegrationConnection[]
): IntegrationConnection[] {
  return connections.filter(
    (connection) =>
      connection.managedByWorkflowId === null &&
      (findProvider(providers, connection.provider)?.triggers.length ?? 0) > 0
  );
}

/** Connections whose provider offers at least one action (usable as a pre or post action). */
export function getActionConnections(
  providers: readonly IntegrationProviderSummary[],
  connections: readonly IntegrationConnection[]
): IntegrationConnection[] {
  return connections.filter(
    (connection) =>
      connection.managedByWorkflowId === null &&
      (findProvider(providers, connection.provider)?.actions.length ?? 0) > 0
  );
}

/** Human label of a trigger type, falling back to the raw key for an unknown type. */
export function getTriggerLabel(
  providers: readonly IntegrationProviderSummary[] | undefined,
  type: string
): string {
  return findTriggerDefinition(providers ?? [], type)?.displayName ?? type;
}

/** Human label of an action type, falling back to the raw key for an unknown type. */
export function getActionLabel(
  providers: readonly IntegrationProviderSummary[] | undefined,
  type: string
): string {
  return findActionDefinition(providers ?? [], type)?.displayName ?? type;
}

/** The provider key a trigger type belongs to (types are prefixed `provider.`). */
export function getTypeProviderKey(type: string): string {
  const separator = type.indexOf(".");
  return separator > 0 ? type.slice(0, separator) : type;
}

/** Enabled triggers of a workflow that support a manual run, with their manual-run prompt. */
export function getManualRunTriggers(
  providers: readonly IntegrationProviderSummary[],
  triggers: readonly WorkflowTrigger[]
): ManualRunTrigger[] {
  const result: ManualRunTrigger[] = [];
  for (const trigger of triggers) {
    const definition = findTriggerDefinition(providers, trigger.type);
    if (trigger.enabled && definition?.manualRun) {
      result.push({
        trigger,
        displayName: definition.displayName,
        manualRun: definition.manualRun,
      });
    }
  }
  return result;
}

/** A trigger a run can be started from by hand (e.g. with a Jira issue key). */
export type ManualRunTrigger = {
  trigger: WorkflowTrigger;
  displayName: string;
  manualRun: NonNullable<IntegrationTriggerSummary["manualRun"]>;
};

/**
 * Form value of a trigger that uses the workflow's own HTTP endpoint. Saved as
 * `connectionId: null`; the API creates the endpoint (URL + secret) on save.
 */
export const BUILT_IN_HTTP_CONNECTION = "built-in-http";
