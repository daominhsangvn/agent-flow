import type {
  IntegrationActionSummary,
  IntegrationProviderSummary,
  IntegrationTriggerSummary,
} from "@repo/api/src/types/integration";
import {
  WORKFLOW_INSTRUCTION_ACTION_TYPE,
  type WorkflowTrigger,
} from "@repo/api/src/types/workflow";
import {
  WORKFLOW_EMAIL_ACTION_TYPE,
  WORKFLOW_EMAIL_LABEL,
} from "@repo/api/src/types/workflow-email";
import { WORKFLOW_INSTRUCTION_LABEL } from "./workflow-labels";

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
  if (type === WORKFLOW_INSTRUCTION_ACTION_TYPE) {
    return WORKFLOW_INSTRUCTION_LABEL;
  }
  if (type === WORKFLOW_EMAIL_ACTION_TYPE) {
    return WORKFLOW_EMAIL_LABEL;
  }
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
