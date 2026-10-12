import { createHash } from "node:crypto";
import type { JsonObject } from "@repo/api/src/types/common";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { truncateText } from "../../markdown";
import type { InboundEvent, SourceItem, SourceItemRef } from "../../types";
import {
  WEBHOOK_REQUEST_KEY_MAX_LENGTH,
  type WebhookRequestBody,
} from "./request-payload";

/**
 * Turns a validated webhook body into the normalized InboundEvent. The item is
 * carried inline (there is no remote system to fetch it from).
 */

export const WebhookTriggerType = {
  Request: "webhook.request",
} as const;
export type WebhookTriggerType =
  (typeof WebhookTriggerType)[keyof typeof WebhookTriggerType];

/**
 * Ids longer than this are replaced by their hash, so a dedupKey still fits
 * workflow_runs.dedup_key (255) after the engine appends ":manual:<uuid>".
 */
const ID_MAX_LENGTH = 200;
const SHORT_HASH_LENGTH = 12;
const GENERATED_KEY_PREFIX = "wh-";
const METADATA_MAX_LENGTH = 10_000;
const BACKTICK_RUN_RE = /`+/g;

export type WebhookEventOptions = {
  /** Delivery id of the request (webhook-id header, body id or body hash). */
  deliveryId: string;
  occurredAt: Date;
};

export function buildWebhookInboundEvent(
  body: WebhookRequestBody,
  options: WebhookEventOptions
): InboundEvent {
  const externalId = boundedId(body.id ?? options.deliveryId);
  const labels = body.labels ?? [];
  const item: SourceItemRef = {
    provider: IntegrationProviderKey.Webhook,
    externalId,
    key: itemKey(body, externalId),
    url: body.url ?? null,
    title: body.title,
    container: null,
  };
  const inlineItem: SourceItem = {
    ...item,
    title: body.title,
    bodyMarkdown: body.description ?? "",
    itemType: body.type ?? null,
    status: null,
    priority: null,
    labels,
    reporter: null,
    assignee: null,
    sections: metadataSections(body.metadata),
    comments: [],
    attachments: [],
  };
  return {
    triggerType: WebhookTriggerType.Request,
    dedupKey: externalId,
    occurredAt: options.occurredAt,
    actor: null,
    item,
    // Values trigger filters match on.
    attributes: { type: body.type ?? null, labels },
    // Handed to actions as run.sourceExtras; webhook.post prefers callbackUrl as target.
    extras: webhookExtras(body),
    inlineItem,
  };
}

/** webhook-id (or svix-id) header, else the body id, else a hash of the raw body. */
export function resolveWebhookDeliveryId(
  headers: Headers,
  body: WebhookRequestBody | null,
  rawBody: string
): string {
  const candidates = [
    headers.get("webhook-id"),
    headers.get("svix-id"),
    body?.id,
  ];
  const explicit = candidates
    .map((candidate) => candidate?.trim() ?? "")
    .find((candidate) => candidate !== "");
  return boundedId(explicit ?? `sha256:${sha256Hex(rawBody)}`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function boundedId(value: string): string {
  return value.length <= ID_MAX_LENGTH ? value : `sha256:${sha256Hex(value)}`;
}

function itemKey(body: WebhookRequestBody, externalId: string): string {
  if (body.key) {
    return body.key;
  }
  if (body.id && body.id.length <= WEBHOOK_REQUEST_KEY_MAX_LENGTH) {
    return body.id;
  }
  return `${GENERATED_KEY_PREFIX}${sha256Hex(externalId).slice(0, SHORT_HASH_LENGTH)}`;
}

/** callbackUrl and metadata, each only when the request sent one. */
function webhookExtras(body: WebhookRequestBody): JsonObject {
  const extras: JsonObject = {};
  if (body.callbackUrl) {
    extras.callbackUrl = body.callbackUrl;
  }
  if (body.metadata && Object.keys(body.metadata).length > 0) {
    extras.metadata = body.metadata;
  }
  return extras;
}

function metadataSections(
  metadata: JsonObject | null | undefined
): SourceItem["sections"] {
  if (!metadata || Object.keys(metadata).length === 0) {
    return [];
  }
  const json = truncateText(
    JSON.stringify(metadata, null, 2),
    METADATA_MAX_LENGTH
  );
  const fence = codeFenceFor(json);
  return [{ title: "Metadata", markdown: `${fence}json\n${json}\n${fence}` }];
}

/** A backtick fence longer than any backtick run in the content, so it cannot be closed early. */
function codeFenceFor(content: string): string {
  let longestRun = 0;
  for (const run of content.matchAll(BACKTICK_RUN_RE)) {
    longestRun = Math.max(longestRun, run[0].length);
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}
