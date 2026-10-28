import { createHash } from "node:crypto";
import { IntegrationDeliveryMode } from "@repo/api/src/types/integration";
import {
  INBOUND_TOKEN_HEADER_DISPLAY,
  verifyStaticToken,
} from "../../inbound-auth";
import type {
  InboundParseResult,
  InboundRequest,
  InboundSecretContext,
  InboundSetupContext,
  InboundVerification,
} from "../../types";
import type { AdoContext } from "./client";
import { AdoIgnoredReason, AdoServiceHookEventType } from "./constants";
import {
  eventsFromCommentedWorkItem,
  eventsFromCreatedWorkItem,
  eventsFromWorkItemUpdate,
  type OccurrenceEvents,
} from "./events";
import {
  type AdoConnectionConfig,
  type AdoServiceHookEnvelope,
  type AdoWorkItemUpdate,
  adoServiceHookEnvelopeSchema,
  adoWorkItemSchema,
  adoWorkItemUpdateSchema,
  readWorkItemFields,
} from "./schemas";

/**
 * Service hook ingress. Service hooks cannot sign payloads, so the request
 * carries the connection's inbound secret in the X-AgentFlow-Token header or
 * as the Basic auth password. The payload is a hint: the engine re-fetches the
 * work item with the PAT before using it.
 */

export function verifyAdoInbound(
  request: InboundRequest,
  context: InboundSecretContext<AdoConnectionConfig>
): InboundVerification {
  return verifyStaticToken(request.headers, context.inboundSecret);
}

export function parseAdoInbound(
  request: InboundRequest,
  ctx: AdoContext
): Promise<InboundParseResult> {
  return Promise.resolve(parseAdoServiceHook(request.rawBody, ctx));
}

export function adoSetupInstructions(
  context: InboundSetupContext<AdoConnectionConfig>
): string {
  if (context.deliveryMode === IntegrationDeliveryMode.Webhook) {
    return webhookInstructions(context.inboundUrl, context.inboundSecret);
  }
  if (context.deliveryMode === IntegrationDeliveryMode.Poll) {
    return POLL_INSTRUCTIONS;
  }
  return NO_INBOUND_INSTRUCTIONS;
}

const PAT_NOTE =
  "The connection uses an organization-scoped personal access token of the bot account (global PATs stop working on December 1, 2026). Assign work items to that account to start workflows.";

const POLL_INSTRUCTIONS = [
  "**Poll mode**: nothing to configure in Azure DevOps.",
  "",
  "AgentFlow asks Azure DevOps for work items assigned to the bot account (WIQL `[System.AssignedTo] = @Me`) at every poll interval and reads their history to find new assignments and added tags.",
  "",
  "Tag triggers, and the tags of **Work item matches conditions** triggers, only see work items that are assigned to the bot in poll mode. To react to tags on other work items, use webhook mode.",
  "",
  "Mention triggers use the `@RecentMentions` query macro (work items whose comments mentioned the bot in the last 30 days).",
  "",
  PAT_NOTE,
].join("\n");

const NO_INBOUND_INSTRUCTIONS =
  "This connection does not receive events. Switch the delivery mode to webhook or poll to use Azure DevOps triggers.";

function parseAdoServiceHook(
  rawBody: string,
  ctx: AdoContext
): InboundParseResult {
  const envelope = adoServiceHookEnvelopeSchema.safeParse(parseJson(rawBody));
  if (!envelope.success) {
    return {
      deliveryId: hashDeliveryId(rawBody),
      eventType: null,
      events: [],
      ignoredReason: AdoIgnoredReason.InvalidPayload,
    };
  }
  const result = eventsFromEnvelope(envelope.data, ctx);
  return {
    deliveryId: resolveDeliveryId(envelope.data, rawBody),
    eventType: envelope.data.eventType,
    events: result.events,
    ...(result.ignoredReason ? { ignoredReason: result.ignoredReason } : {}),
  };
}

function eventsFromEnvelope(
  envelope: AdoServiceHookEnvelope,
  ctx: AdoContext
): OccurrenceEvents {
  const isCreated =
    envelope.eventType === AdoServiceHookEventType.WorkItemCreated;
  const isUpdated =
    envelope.eventType === AdoServiceHookEventType.WorkItemUpdated;
  const isCommented =
    envelope.eventType === AdoServiceHookEventType.WorkItemCommented;
  if (!(isCreated || isUpdated || isCommented)) {
    return { events: [], ignoredReason: AdoIgnoredReason.UnsupportedEvent };
  }
  const account = ctx.connection.account;
  if (!account) {
    return { events: [], ignoredReason: AdoIgnoredReason.BotAccountUnknown };
  }
  const common = {
    organizationUrl: ctx.connection.config.organizationUrl,
    projectFallback: envelope.resourceContainers?.project?.id ?? null,
    account,
    occurredAtFallback: envelopeDate(envelope) ?? ctx.now(),
  };
  if (isCreated || isCommented) {
    const workItem = adoWorkItemSchema.safeParse(envelope.resource);
    if (!workItem.success) {
      return { events: [], ignoredReason: AdoIgnoredReason.InvalidPayload };
    }
    const input = { ...common, workItem: workItem.data };
    return isCreated
      ? eventsFromCreatedWorkItem(input)
      : eventsFromCommentedWorkItem(input);
  }
  const update = adoWorkItemUpdateSchema.safeParse(envelope.resource);
  const workItemId = update.success ? updatedWorkItemId(update.data) : null;
  if (!(update.success && workItemId)) {
    return { events: [], ignoredReason: AdoIgnoredReason.InvalidPayload };
  }
  return eventsFromWorkItemUpdate({
    ...common,
    workItemId,
    update: update.data,
    fields: readWorkItemFields(update.data.revision?.fields),
  });
}

/** `resource.id` of a workitem.updated payload is the UPDATE id; the work item is workItemId or revision.id. */
function updatedWorkItemId(update: AdoWorkItemUpdate): number | null {
  if (update.workItemId && update.workItemId > 0) {
    return update.workItemId;
  }
  const revisionId = update.revision?.id;
  return revisionId && revisionId > 0 ? revisionId : null;
}

function resolveDeliveryId(
  envelope: AdoServiceHookEnvelope,
  rawBody: string
): string {
  if (envelope.id) {
    return envelope.id;
  }
  if (
    envelope.subscriptionId &&
    envelope.notificationId !== null &&
    envelope.notificationId !== undefined
  ) {
    return `${envelope.subscriptionId}:${envelope.notificationId}`;
  }
  return hashDeliveryId(rawBody);
}

function envelopeDate(envelope: AdoServiceHookEnvelope): Date | null {
  if (!envelope.createdDate) {
    return null;
  }
  const date = new Date(envelope.createdDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hashDeliveryId(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function webhookInstructions(
  inboundUrl: string,
  inboundSecret: string
): string {
  return [
    "**Azure DevOps service hooks** (repeat for every project whose work items should start workflows)",
    "",
    "1. In Azure DevOps open **Project settings → Service hooks** and select **+** (Create subscription).",
    "2. Choose **Web Hooks**, then **Next**.",
    '3. Trigger on **Work item updated**. Optional filters: area path, work item type, tag. Leave **Field** empty, or set it to **Assigned To** when no workflow reacts to tags or mentions (the "Tag added", "Bot mentioned" triggers, or tags and mentions in "Work item matches conditions"). Select **Next**.',
    "4. Action settings:",
    `   - **URL**: \`${inboundUrl}\``,
    `   - **HTTP headers**: \`${INBOUND_TOKEN_HEADER_DISPLAY}:${inboundSecret}\``,
    "     (or leave the headers empty and use **Basic authentication** with any username and the secret as the password)",
    "   - **Resource details to send**: All",
    "   - **Messages to send** and **Detailed messages to send**: None",
    "5. Select **Test**, then **Finish**.",
    "6. Repeat steps 1-5 with the **Work item created** event, so work items created already assigned to the bot (or already tagged) start workflows too.",
    '7. For the "Bot mentioned on a work item" trigger, and "Work item matches conditions" triggers that use mentions, repeat steps 1-5 with the **Work item commented on** event as well.',
    "",
    "Azure DevOps must reach the URL over public HTTPS; it refuses localhost and private IP addresses. If this server is not reachable from the internet, switch the connection to **poll** mode.",
    "",
    PAT_NOTE,
  ].join("\n");
}
