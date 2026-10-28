import {
  createIntegrationConnectionInputSchema,
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { integrationConnectionService } from "@/lib/integrations/connection-service";
import type {
  PersistableAction,
  PersistableTrigger,
  ValidatedAction,
  ValidatedTrigger,
} from "./workflow-validation";

/**
 * A workflow's built-in HTTP trigger and HTTPS call. Both use an ordinary
 * webhook connection (inbound URL + secret, Standard Webhooks signing) that
 * the workflow owns: `managedByWorkflowId` hides it from Settings, keeps other
 * workflows from using it, and deletes it with the workflow. Called inside
 * the workflow save transaction.
 */

/** Connection names are limited to 120 characters. */
const ENDPOINT_NAME_MAX = 120;

export type BuiltInHttpInput = {
  organizationId: string;
  workflowId: string;
  userId: string;
  workflowName: string;
  triggers: ValidatedTrigger[];
  actions: ValidatedAction[];
};

export type ResolvedChildren = {
  triggers: PersistableTrigger[];
  actions: PersistableAction[];
};

/**
 * Points built-in triggers (no project connection) and built-in actions (no
 * key, not automatic) at the workflow's endpoint, creating it once.
 */
export async function resolveBuiltInHttpChildren(
  input: BuiltInHttpInput
): Promise<Result<ResolvedChildren, string>> {
  const usesEndpoint =
    input.triggers.some((trigger) => trigger.connectionId === null) ||
    input.actions.some(isBuiltInAction);
  if (!usesEndpoint) {
    return Result.ok({
      triggers: input.triggers.map((trigger) => ({
        ...trigger,
        connectionId: trigger.connectionId ?? "",
      })),
      actions: input.actions.map(toPersistableAction(null)),
    });
  }
  const endpoint = await ensureWorkflowHttpEndpoint(input);
  if (!endpoint.ok) {
    return endpoint;
  }
  return Result.ok({
    triggers: input.triggers.map((trigger) => ({
      ...trigger,
      connectionId: trigger.connectionId ?? endpoint.value,
    })),
    actions: input.actions.map(toPersistableAction(endpoint.value)),
  });
}

/** A built-in action gets the endpoint; the others keep no connection id. */
function toPersistableAction(endpointId: string | null) {
  return (action: ValidatedAction): PersistableAction => {
    const { automaticConnection: _automatic, ...rest } = action;
    return {
      ...rest,
      connectionId: isBuiltInAction(action) ? endpointId : null,
    };
  };
}

function isBuiltInAction(action: ValidatedAction): boolean {
  return action.connectionKey === null && !action.automaticConnection;
}

/** Deletes the workflow's endpoint once no trigger or action uses it any more. */
export async function removeUnusedWorkflowHttpEndpoint(
  organizationId: string,
  workflowId: string
): Promise<void> {
  await withDb((db) =>
    db.integrationConnection.deleteMany({
      where: {
        organizationId,
        managedByWorkflowId: workflowId,
        triggers: { none: {} },
        actions: { none: {} },
      },
    })
  );
}

async function ensureWorkflowHttpEndpoint(
  input: BuiltInHttpInput
): Promise<Result<string, string>> {
  const existing = await withDb((db) =>
    db.integrationConnection.findFirst({
      where: {
        organizationId: input.organizationId,
        managedByWorkflowId: input.workflowId,
      },
      select: { id: true },
    })
  );
  if (existing) {
    return Result.ok(existing.id);
  }
  const created = await integrationConnectionService.create(
    input.organizationId,
    input.userId,
    createIntegrationConnectionInputSchema.parse({
      provider: IntegrationProviderKey.Webhook,
      name: endpointName(input.workflowName),
      deliveryMode: IntegrationDeliveryMode.Webhook,
    })
  );
  if (!created.ok) {
    return Result.err(
      `Could not create the workflow's HTTP endpoint: ${created.error.message}`
    );
  }
  await withDb((db) =>
    db.integrationConnection.update({
      where: { id: created.value.id },
      data: { managedByWorkflowId: input.workflowId },
    })
  );
  return Result.ok(created.value.id);
}

function endpointName(workflowName: string): string {
  const name = `HTTP · ${workflowName}`;
  return name.length > ENDPOINT_NAME_MAX
    ? `${name.slice(0, ENDPOINT_NAME_MAX - 1)}…`
    : name;
}
