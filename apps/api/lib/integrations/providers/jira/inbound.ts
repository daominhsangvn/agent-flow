import { createHash } from "node:crypto";
import { Result } from "@repo/api/src/types/result";
import { verifyHubSignature, verifyStaticToken } from "../../inbound-auth";
import type {
  InboundEvent,
  InboundParseResult,
  InboundRequest,
  InboundSecretContext,
  InboundVerification,
  IntegrationAccount,
} from "../../types";
import type { JiraContext } from "./client";
import {
  JIRA_AUTOMATION_EVENT_TYPE,
  JIRA_HUB_SIGNATURE_HEADER,
  JIRA_WEBHOOK_IDENTIFIER_HEADER,
  JiraIgnoredReason,
  JiraWebhookEvent,
} from "./constants";
import { parseEpochMillis } from "./dates";
import { isJiraBotUser, jiraUserActor } from "./identity";
import {
  isAssignedToBot,
  type JiraIssueOccurrence,
  jiraAssignedEvent,
  jiraChangeEvents,
  jiraCommentMentionEvents,
  jiraCreatedEvents,
} from "./issue-events";
import {
  type JiraConnectionConfig,
  type JiraWebhookBody,
  jiraWebhookBodySchema,
  jiraWebhookEnvelopeSchema,
} from "./schemas";

/**
 * Inbound side of the Jira provider (webhook mode).
 *
 * Accepted credentials: the `X-Hub-Signature` HMAC of a Jira admin webhook
 * configured with the inbound secret, or (Jira Automation "Send web request",
 * which cannot sign) the inbound secret in the `X-AgentFlow-Token` header. A
 * request that presents a signature is never downgraded to token checking.
 *
 * Accepted bodies: admin webhooks `jira:issue_created` / `jira:issue_updated`
 * / `comment_created` / `comment_updated` and Automation "Work item data (Jira format)" bodies (no `webhookEvent`),
 * which are treated as "assigned" notifications checked against the current
 * assignee. Everything else is acknowledged with an ignored reason.
 */

const SUPPORTED_WEBHOOK_EVENTS = new Set<string>(
  Object.values(JiraWebhookEvent)
);
const DELIVERY_ID_MAX_LENGTH = 255;
const EVENT_TYPE_MAX_LENGTH = 128;
const AUTOMATION_CHANGE_PREFIX = "automation-";

export function verifyJiraRequest(
  request: InboundRequest,
  context: InboundSecretContext<JiraConnectionConfig>
): InboundVerification {
  const signature = request.headers.get(JIRA_HUB_SIGNATURE_HEADER);
  if (signature !== null) {
    return verifyHubSignature(
      request.rawBody,
      signature,
      context.inboundSecret
    );
  }
  return verifyStaticToken(request.headers, context.inboundSecret);
}

export function parseJiraRequest(
  request: InboundRequest,
  ctx: JiraContext
): Promise<InboundParseResult> {
  return Promise.resolve(parseJiraDelivery(request, ctx));
}

/** X-Atlassian-Webhook-Identifier (stable across Jira retries), else a hash of the body. */
export function resolveJiraDeliveryId(request: InboundRequest): string {
  const identifier = request.headers
    .get(JIRA_WEBHOOK_IDENTIFIER_HEADER)
    ?.trim();
  if (identifier && identifier.length <= DELIVERY_ID_MAX_LENGTH) {
    return identifier;
  }
  return createHash("sha256").update(request.rawBody, "utf8").digest("hex");
}

function parseJiraDelivery(
  request: InboundRequest,
  ctx: JiraContext
): InboundParseResult {
  const deliveryId = resolveJiraDeliveryId(request);
  const json = parseJson(request.rawBody);
  if (!json.ok) {
    return ignored(deliveryId, null, JiraIgnoredReason.InvalidPayload);
  }
  const envelope = jiraWebhookEnvelopeSchema.safeParse(json.value);
  if (!envelope.success) {
    return ignored(deliveryId, null, JiraIgnoredReason.InvalidPayload);
  }
  const webhookEvent = envelope.data.webhookEvent ?? null;
  if (webhookEvent !== null && !SUPPORTED_WEBHOOK_EVENTS.has(webhookEvent)) {
    return ignored(
      deliveryId,
      webhookEvent.slice(0, EVENT_TYPE_MAX_LENGTH),
      JiraIgnoredReason.UnsupportedEvent
    );
  }
  const eventType = webhookEvent ?? JIRA_AUTOMATION_EVENT_TYPE;
  const body = jiraWebhookBodySchema.safeParse(json.value);
  if (!body.success) {
    return ignored(deliveryId, eventType, JiraIgnoredReason.InvalidPayload);
  }
  const account = ctx.connection.account;
  if (!account) {
    return ignored(deliveryId, eventType, JiraIgnoredReason.BotAccountUnknown);
  }
  if (
    isJiraBotUser(account, body.data.user) ||
    (isCommentEvent(body.data.webhookEvent) &&
      isJiraBotUser(account, commentAuthor(body.data)))
  ) {
    return ignored(deliveryId, eventType, JiraIgnoredReason.CausedByBot);
  }
  const events = eventsFromBody(body.data, {
    account,
    deliveryId,
    siteUrl: ctx.connection.config.siteUrl,
    now: ctx.now(),
  });
  if (events.length === 0) {
    return ignored(deliveryId, eventType, JiraIgnoredReason.NoRelevantChange);
  }
  return { deliveryId, eventType, events };
}

type BodyContext = {
  account: IntegrationAccount;
  deliveryId: string;
  siteUrl: string;
  now: Date;
};

function eventsFromBody(
  body: JiraWebhookBody,
  context: BodyContext
): InboundEvent[] {
  const occurrence: JiraIssueOccurrence = {
    siteUrl: context.siteUrl,
    issue: body.issue,
    occurredAt: parseEpochMillis(body.timestamp) ?? context.now,
    actor: jiraUserActor(body.user),
  };
  if (body.webhookEvent === JiraWebhookEvent.IssueCreated) {
    return jiraCreatedEvents(occurrence, context.account);
  }
  if (isCommentEvent(body.webhookEvent)) {
    return body.comment
      ? jiraCommentMentionEvents(
          { ...occurrence, actor: jiraUserActor(commentAuthor(body)) },
          body.comment,
          context.account
        )
      : [];
  }
  if (body.webhookEvent === JiraWebhookEvent.IssueUpdated) {
    return jiraChangeEvents(
      occurrence,
      body.changelog?.items ?? [],
      body.changelog?.id ?? context.deliveryId,
      context.account
    );
  }
  return automationEvents(occurrence, context);
}

/**
 * Automation bodies carry no changelog: the rule ("Work item assigned" with
 * an assignee condition) already decided, so only the current assignee is
 * checked. Each rule execution is its own occurrence.
 */
function automationEvents(
  occurrence: JiraIssueOccurrence,
  context: BodyContext
): InboundEvent[] {
  if (!isAssignedToBot(occurrence.issue, context.account)) {
    return [];
  }
  return [
    jiraAssignedEvent(
      occurrence,
      `${AUTOMATION_CHANGE_PREFIX}${context.deliveryId}`
    ),
  ];
}

function isCommentEvent(webhookEvent: string | null | undefined): boolean {
  return (
    webhookEvent === JiraWebhookEvent.CommentCreated ||
    webhookEvent === JiraWebhookEvent.CommentUpdated
  );
}

/** Who wrote (or last edited) the comment of a comment event. */
function commentAuthor(body: JiraWebhookBody) {
  return body.comment?.updateAuthor ?? body.comment?.author ?? null;
}

function ignored(
  deliveryId: string,
  eventType: string | null,
  reason: JiraIgnoredReason
): InboundParseResult {
  return { deliveryId, eventType, events: [], ignoredReason: reason };
}

function parseJson(rawBody: string): Result<unknown, string> {
  try {
    return Result.ok(JSON.parse(rawBody));
  } catch {
    return Result.err("invalid_json");
  }
}
