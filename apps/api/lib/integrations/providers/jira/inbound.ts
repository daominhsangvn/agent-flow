import { createHash } from "node:crypto";
import { Result } from "@repo/api/src/types/result";
import { verifyHubSignature, verifyStaticToken } from "../../inbound-auth";
import {
  HttpMethod,
  type InboundEvent,
  type InboundMessage,
  type InboundParseResult,
  type InboundRequest,
  type InboundSecretContext,
  type InboundVerification,
  type IntegrationAccount,
} from "../../types";
import { adfToPlainText } from "../atlassian/adf";
import { type JiraContext, jiraIssuePath, jiraRequest } from "./client";
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
  itemChangeEvents,
  type JiraIssueOccurrence,
  jiraAssignedEvent,
  jiraChangeEvents,
  jiraCommentMentionEvents,
  jiraCommentReplyEvent,
  jiraConditionsEvent,
  jiraCreatedEvents,
  jiraIssueState,
} from "./issue-events";
import { mentionsJiraBot } from "./mentions";
import {
  type JiraConnectionConfig,
  type JiraIssue,
  type JiraWebhookBody,
  jiraIssueSchema,
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
 *
 * The issue of a comment webhook carries only a few fields (no labels), so a
 * comment that mentions the bot is followed by one read of the issue, for the
 * triggers' label and status filters.
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
  return parseJiraDelivery(request, ctx);
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

async function parseJiraDelivery(
  request: InboundRequest,
  ctx: JiraContext
): Promise<InboundParseResult> {
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
  const events = await eventsFromBody(body.data, {
    ctx,
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
  ctx: JiraContext;
  account: IntegrationAccount;
  deliveryId: string;
  siteUrl: string;
  now: Date;
};

async function eventsFromBody(
  body: JiraWebhookBody,
  context: BodyContext
): Promise<InboundEvent[]> {
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
    return await commentEvents(body, occurrence, context);
  }
  if (body.webhookEvent === JiraWebhookEvent.IssueUpdated) {
    return jiraChangeEvents(
      occurrence,
      body.changelog?.items ?? [],
      body.changelog?.id ?? context.deliveryId,
      context.account
    );
  }
  return automationEvents(body, occurrence, context);
}

/**
 * Automation bodies may carry a changelog: its status and label items yield
 * their events whatever the assignee is. The rule ("Work item assigned" with
 * an assignee condition) already decided the assignment, so only the current
 * assignee is checked. Each rule execution is its own occurrence.
 */
function automationEvents(
  body: JiraWebhookBody,
  occurrence: JiraIssueOccurrence,
  context: BodyContext
): InboundEvent[] {
  const changeId = `${AUTOMATION_CHANGE_PREFIX}${context.deliveryId}`;
  const changeEvents = itemChangeEvents(
    occurrence,
    body.changelog?.items ?? [],
    changeId
  );
  if (!isAssignedToBot(occurrence.issue, context.account)) {
    return changeEvents;
  }
  return [
    ...changeEvents,
    jiraAssignedEvent(occurrence, changeId),
    jiraConditionsEvent({
      occurrence,
      facts: { becameAssigned: true, addedLabels: [], mentioned: false },
      state: jiraIssueState(occurrence.issue, context.account),
      changeId,
    }),
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

const COMMENTED_ISSUE_FIELDS =
  "summary,issuetype,labels,status,assignee,project";

/**
 * The commented issue as REST returns it (with its labels); the webhook's
 * trimmed issue when Jira cannot be read, so the mention still counts.
 */
async function loadCommentedIssue(
  ctx: JiraContext,
  issue: JiraIssue
): Promise<JiraIssue> {
  const fetched = await jiraRequest(
    ctx,
    {
      method: HttpMethod.Get,
      path: jiraIssuePath(issue.id),
      query: { fields: COMMENTED_ISSUE_FIELDS },
    },
    jiraIssueSchema
  );
  if (fetched.ok) {
    return fetched.value;
  }
  ctx.log.warn(
    "Could not read the commented Jira issue; using the webhook's fields",
    {
      connectionId: ctx.connection.id,
      issueKey: issue.key,
      status: fetched.error.status,
      kind: fetched.error.kind,
    }
  );
  return issue;
}

/**
 * A new reply in a comment thread (jira.comment_reply, first: it can resume
 * the run that posted the comment), then the mention events when the comment
 * mentions the bot. Jira's Reply mentions the replied comment's author, so a
 * reply to the bot's comment is usually both.
 */
async function commentEvents(
  body: JiraWebhookBody,
  occurrence: JiraIssueOccurrence,
  context: BodyContext
): Promise<InboundEvent[]> {
  const comment = body.comment;
  if (!comment) {
    return [];
  }
  const actor = jiraUserActor(commentAuthor(body));
  const events: InboundEvent[] = [];
  // An edited reply was answered (or not) when it was written.
  if (
    body.webhookEvent === JiraWebhookEvent.CommentCreated &&
    comment.parentId
  ) {
    events.push(
      jiraCommentReplyEvent(
        { ...occurrence, actor },
        { id: comment.id, parentId: comment.parentId }
      )
    );
  }
  if (mentionsJiraBot(comment.body, context.account)) {
    events.push(
      ...jiraCommentMentionEvents(
        {
          ...occurrence,
          issue: await loadCommentedIssue(context.ctx, body.issue),
          actor,
        },
        comment,
        context.account
      )
    );
  }
  const message: InboundMessage = {
    id: comment.id,
    parentId: comment.parentId ?? null,
    text: commentText(comment.body),
  };
  return events.map((event) => ({ ...event, message }));
}

/** A webhook comment's text: wiki markup as written, ADF as plain text. */
function commentText(body: unknown): string {
  return typeof body === "string" ? body : adfToPlainText(body);
}
