import type { JsonValue } from "@repo/api/src/types/common";
import {
  OrchestratorCaseStatus,
  OrchestratorMessageKind,
  OrchestratorMessageOrigin,
} from "@repo/api/src/types/orchestrator";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { getPrismaErrorCode } from "@/lib/db-utils";
import type { LoadedConnection } from "@/lib/integrations/connection-service";
import type { InboundEvent } from "@/lib/integrations/types";
import { waitUntil } from "@/lib/wait-until";
import { advanceConversation } from "./advance";
import {
  caseSourceKey,
  channelFromEvent,
  channelKeyFor,
  readChannel,
  withLatestExtras,
} from "./channel";
import { ticketChangeMessage } from "./ticket-change";
import {
  loadOrchestratorWorkflows,
  type OrchestratorWorkflow,
} from "./workflow-settings";

/**
 * External requests to the orchestrators of orchestrated workflows (docs/orchestrator.md). An
 * inbound event reaches it when a trigger of an orchestrated workflow matched,
 * or when it replies to a message the orchestrator posted (an anchor), whatever
 * the triggers. The conversation is found without asking a model: the anchor
 * replied to, else the Teams thread or the issue's comment thread or top
 * level; a new one opens a case per source item and workflow. The message waits there for
 * the thread to be quiet (debounce), then a turn takes it (advance.ts). A change of the
 * ticket itself (event.itemChange: status, labels) is recorded as a status_changed /
 * label_added / label_removed message on the item conversation (ticket-change.ts).
 */

const PRISMA_UNIQUE_VIOLATION = "P2002";
const TEXT_MAX = 30_000;
const LOG_PREFIX = "[orchestrator/inbound]";
/** Conversations on one channel that continue an unanchored reply. */
const CONTINUED_MAX = 20;

export type OrchestratorRouteInput = {
  connection: LoadedConnection;
  event: InboundEvent;
  projectConnectionId: string;
  /** Orchestrated workflows whose trigger matched the event. */
  workflows: ReadonlyArray<{ workflowId: string; projectId: string }>;
};

export type OrchestratorRouteResult = {
  conversationId: string;
  workflowId: string;
  /** False when the message was already recorded (a retried delivery). */
  created: boolean;
};

/** Where one orchestrated workflow takes the event: an existing conversation or a new one. */
type RouteTarget = {
  workflowId: string;
  projectId: string;
  conversationId: string | null;
};

type KnownConversation = {
  id: string;
  projectId: string;
  case: { workflowId: string };
};

export async function routeToOrchestrator(
  input: OrchestratorRouteInput
): Promise<OrchestratorRouteResult[]> {
  const { event } = input;
  const organizationId = input.connection.record.organizationId;
  const parentId =
    event.message?.parentId ??
    input.connection.provider.answerReply?.(event) ??
    null;
  const targets = await resolveTargets(input, organizationId, parentId);
  if (targets.length === 0) {
    return [];
  }
  const settings = await loadOrchestratorWorkflows(
    organizationId,
    targets.map((target) => target.workflowId)
  );
  const results: OrchestratorRouteResult[] = [];
  for (const target of targets) {
    const workflow = settings.get(target.workflowId);
    if (!workflow?.enabled) {
      log.info(`${LOG_PREFIX} workflow is not an enabled orchestrator`, {
        workflowId: target.workflowId,
        dedupKey: event.dedupKey,
      });
      continue;
    }
    results.push(
      await deliver({ input, organizationId, parentId, target, workflow })
    );
  }
  return results;
}

/**
 * The workflows that take the event: the anchor's conversation, every
 * orchestrated workflow whose trigger matched, and (when neither applies) the
 * conversations already talking where the event was written.
 */
async function resolveTargets(
  input: OrchestratorRouteInput,
  organizationId: string,
  parentId: string | null
): Promise<RouteTarget[]> {
  const { event } = input;
  const anchored = parentId
    ? await withDb((db) =>
        db.orchestratorAnchor.findUnique({
          where: {
            organizationId_provider_externalRef: {
              organizationId,
              provider: event.item.provider,
              externalRef: parentId,
            },
          },
          select: {
            conversation: {
              select: {
                id: true,
                projectId: true,
                case: { select: { workflowId: true } },
              },
            },
          },
        })
      )
    : null;
  const targets: RouteTarget[] = [];
  if (anchored) {
    targets.push(toKnownTarget(anchored.conversation));
  }
  const seen = new Set(targets.map((target) => target.workflowId));
  for (const workflow of input.workflows) {
    if (!seen.has(workflow.workflowId)) {
      seen.add(workflow.workflowId);
      targets.push({
        workflowId: workflow.workflowId,
        projectId: workflow.projectId,
        conversationId: null,
      });
    }
  }
  if (targets.length > 0) {
    return targets;
  }
  // No trigger matched and no anchor: conversations already talking where the
  // event was written (a Teams thread, a comment thread) continue.
  const continued: KnownConversation[] = await withDb((db) =>
    db.orchestratorConversation.findMany({
      where: {
        organizationId,
        projectConnectionId: input.projectConnectionId,
        channelKey: channelKeyFor(event.item, parentId),
      },
      select: {
        id: true,
        projectId: true,
        case: { select: { workflowId: true } },
      },
      take: CONTINUED_MAX,
    })
  );
  return continued.map(toKnownTarget);
}

function toKnownTarget(conversation: KnownConversation): RouteTarget {
  return {
    workflowId: conversation.case.workflowId,
    projectId: conversation.projectId,
    conversationId: conversation.id,
  };
}

/** Records the event in the target's conversation (opening it first when new). */
async function deliver(args: {
  input: OrchestratorRouteInput;
  organizationId: string;
  parentId: string | null;
  target: RouteTarget;
  workflow: OrchestratorWorkflow;
}): Promise<OrchestratorRouteResult> {
  const { input, organizationId, target, workflow } = args;
  const conversationId =
    target.conversationId ??
    (await openConversation({
      organizationId,
      projectId: target.projectId,
      workflowId: target.workflowId,
      projectConnectionId: input.projectConnectionId,
      event: input.event,
      parentId: args.parentId,
    }));
  const created = await recordMessage({
    organizationId,
    conversationId,
    event: input.event,
    workflowNames: [workflow.name],
    debounceSeconds: workflow.debounceSeconds,
  });
  if (created && workflow.debounceSeconds === 0) {
    waitUntil(advanceConversation(conversationId));
  }
  return { conversationId, workflowId: target.workflowId, created };
}

async function openConversation(input: {
  organizationId: string;
  projectId: string;
  workflowId: string;
  projectConnectionId: string;
  event: InboundEvent;
  parentId: string | null;
}): Promise<string> {
  const { organizationId, projectId, workflowId, event } = input;
  const sourceKey = caseSourceKey(event.item);
  const channelKey = channelKeyFor(event.item, input.parentId);
  return await withDb.tx(async (tx) => {
    const found = await tx.orchestratorCase.upsert({
      where: { workflowId_sourceKey: { workflowId, sourceKey } },
      create: {
        organizationId,
        projectId,
        workflowId,
        sourceKey,
        title: caseTitle(event),
      },
      update: { status: OrchestratorCaseStatus.Open },
      select: { id: true },
    });
    const existing = await tx.orchestratorConversation.findUnique({
      where: { caseId_channelKey: { caseId: found.id, channelKey } },
      select: { id: true, channel: true },
    });
    if (existing) {
      const channel = readChannel(existing.channel);
      await tx.orchestratorConversation.update({
        where: { id: existing.id },
        data: channel
          ? {
              channel: withLatestExtras(
                channel,
                event.extras
              ) as Prisma.InputJsonValue,
            }
          : {},
      });
      return existing.id;
    }
    const conversation = await tx.orchestratorConversation.create({
      data: {
        organizationId,
        projectId,
        caseId: found.id,
        channelKey,
        projectConnectionId: input.projectConnectionId,
        channel: channelFromEvent(
          event,
          input.parentId
        ) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return conversation.id;
  });
}

/** Records the message once; true when it is new. */
async function recordMessage(input: {
  organizationId: string;
  conversationId: string;
  event: InboundEvent;
  workflowNames: string[];
  debounceSeconds: number;
}): Promise<boolean> {
  const { event } = input;
  // One comment can raise several events (a reply that mentions the bot): it
  // is one message.
  const dedupKey = event.message?.id
    ? `message:${event.message.id}`
    : event.dedupKey;
  const now = new Date();
  const content = messageContent(event);
  try {
    await withDb.tx(async (tx) => {
      await tx.orchestratorMessage.create({
        data: {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          origin: OrchestratorMessageOrigin.External,
          kind: content.kind,
          actor: event.actor?.displayName ?? event.actor?.id ?? null,
          text: content.text.trim().slice(0, TEXT_MAX),
          externalRef: event.message?.id ?? null,
          dedupKey: dedupKey.slice(0, 255),
          payload: {
            ...content.payload,
            triggerType: event.triggerType,
            item: event.item.key,
            url: event.item.url,
            workflows: input.workflowNames,
            // The comment it replies to: an answer goes in that thread.
            parentId: event.message?.parentId ?? null,
          },
        },
      });
      await tx.orchestratorConversation.updateMany({
        where: { id: input.conversationId },
        // The next turn starts once the thread is quiet; a running turn
        // and the conversation's status are advance.ts's.
        data: {
          nextWakeAt: new Date(now.getTime() + input.debounceSeconds * 1000),
        },
      });
    });
    return true;
  } catch (error) {
    if (getPrismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION) {
      return false;
    }
    throw error;
  }
}

/** Kind, text and extra payload of the message an event records. */
function messageContent(event: InboundEvent): {
  kind: OrchestratorMessageKind;
  text: string;
  payload: Record<string, JsonValue>;
} {
  const actor = event.actor?.displayName ?? event.actor?.id ?? null;
  const change = event.itemChange
    ? ticketChangeMessage(event.itemChange, actor)
    : null;
  if (change) {
    return change;
  }
  return {
    kind: OrchestratorMessageKind.Message,
    text: event.message?.text ?? event.item.title ?? event.item.key,
    payload: {},
  };
}

function caseTitle(event: InboundEvent): string {
  const title = event.item.title?.trim();
  return (title ? `${event.item.key}: ${title}` : event.item.key).slice(0, 255);
}
