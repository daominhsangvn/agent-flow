import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  generateStandardWebhookSecret,
  INBOUND_TOKEN_HEADER,
  signStandardWebhook,
} from "../../../inbound-auth";
import { parseWebhookRequest, verifyWebhookRequest } from "../inbound";
import { sha256Hex, WebhookTriggerType } from "../inbound-event";
import {
  inboundRequest,
  makeWebhookContext,
  NOW,
} from "./webhook.test-helpers";

const INVALID_TITLE_REASON_RE = /^invalid_payload: title: /;
const INBOUND_SECRET = generateStandardWebhookSecret();
const BODY = JSON.stringify({ id: "evt-1", title: "Add CSV export" });

function secretContext(inboundSecret = INBOUND_SECRET) {
  const { connection } = makeWebhookContext();
  return { connection, inboundSecret };
}

function signedHeaders(
  rawBody: string,
  options: { secret?: string; timestamp?: number; prefix?: string } = {}
): Record<string, string> {
  const id = "msg_2abc";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const prefix = options.prefix ?? "webhook";
  return {
    [`${prefix}-id`]: id,
    [`${prefix}-timestamp`]: String(timestamp),
    [`${prefix}-signature`]: signStandardWebhook(
      id,
      timestamp,
      rawBody,
      options.secret ?? INBOUND_SECRET
    ),
  };
}

describe("verifyWebhookRequest", () => {
  it("accepts a valid Standard Webhooks signature", () => {
    const request = inboundRequest(BODY, signedHeaders(BODY));

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: true,
    });
  });

  it("accepts the svix-* header aliases", () => {
    const request = inboundRequest(
      BODY,
      signedHeaders(BODY, { prefix: "svix" })
    );

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: true,
    });
  });

  it("rejects a signature made with another secret", () => {
    const request = inboundRequest(
      BODY,
      signedHeaders(BODY, { secret: generateStandardWebhookSecret() })
    );

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a tampered body", () => {
    const request = inboundRequest(`${BODY} `, signedHeaders(BODY));

    expect(verifyWebhookRequest(request, secretContext()).ok).toBe(false);
  });

  it("never falls back to the token when a signature is presented", () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const request = inboundRequest(BODY, {
      ...signedHeaders(BODY, { timestamp: staleTimestamp }),
      [INBOUND_TOKEN_HEADER]: INBOUND_SECRET,
    });

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("accepts the inbound secret in the X-AgentFlow-Token header", () => {
    const request = inboundRequest(BODY, {
      "X-AgentFlow-Token": INBOUND_SECRET,
    });

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong token", () => {
    const request = inboundRequest(BODY, { [INBOUND_TOKEN_HEADER]: "nope" });

    expect(verifyWebhookRequest(request, secretContext())).toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });

  it("rejects a request without credentials", () => {
    expect(verifyWebhookRequest(inboundRequest(BODY), secretContext())).toEqual(
      {
        ok: false,
        reason: "missing_token",
      }
    );
  });
});

describe("parseWebhookRequest", () => {
  const context = makeWebhookContext();

  it("builds one event with the item carried inline", async () => {
    const rawBody = JSON.stringify({
      id: "evt-1",
      key: "REQ-7",
      title: "Add CSV export",
      description: "Users need **CSV**.",
      url: "https://tracker.example.com/REQ-7",
      type: "feature",
      labels: ["reports"],
      callbackUrl: "https://example.com/hooks/agentflow",
      metadata: { requester: "ba@example.com", priority: 2 },
    });

    const result = await parseWebhookRequest(
      inboundRequest(rawBody, { "webhook-id": "msg_1" }),
      context
    );

    const item = {
      provider: IntegrationProviderKey.Webhook,
      externalId: "evt-1",
      key: "REQ-7",
      url: "https://tracker.example.com/REQ-7",
      title: "Add CSV export",
      container: null,
    };
    expect(result).toEqual({
      deliveryId: "msg_1",
      eventType: WebhookTriggerType.Request,
      events: [
        {
          triggerType: WebhookTriggerType.Request,
          dedupKey: "evt-1",
          occurredAt: NOW,
          actor: null,
          item,
          attributes: { type: "feature", labels: ["reports"] },
          extras: {
            callbackUrl: "https://example.com/hooks/agentflow",
            metadata: { requester: "ba@example.com", priority: 2 },
          },
          inlineItem: {
            ...item,
            bodyMarkdown: "Users need **CSV**.",
            itemType: "feature",
            status: null,
            priority: null,
            labels: ["reports"],
            reporter: null,
            assignee: null,
            sections: [
              {
                title: "Metadata",
                markdown:
                  '```json\n{\n  "requester": "ba@example.com",\n  "priority": 2\n}\n```',
              },
            ],
            comments: [],
            attachments: [],
          },
        },
      ],
    });
  });

  it("uses the body id as delivery id without a webhook-id header", async () => {
    const result = await parseWebhookRequest(inboundRequest(BODY), context);

    expect(result.deliveryId).toBe("evt-1");
    expect(result.events[0]?.dedupKey).toBe("evt-1");
    expect(result.events[0]?.item.key).toBe("evt-1");
  });

  it("falls back to a body hash and a generated key without any id", async () => {
    const rawBody = JSON.stringify({ title: "No ids" });

    const result = await parseWebhookRequest(inboundRequest(rawBody), context);

    const deliveryId = `sha256:${sha256Hex(rawBody)}`;
    expect(result.deliveryId).toBe(deliveryId);
    expect(result.events[0]?.dedupKey).toBe(deliveryId);
    expect(result.events[0]?.item.externalId).toBe(deliveryId);
    expect(result.events[0]?.item.key).toBe(
      `wh-${sha256Hex(deliveryId).slice(0, 12)}`
    );
    expect(result.events[0]?.attributes).toEqual({ type: null, labels: [] });
    expect(result.events[0]?.extras).toEqual({});
  });

  it("uses the webhook-id header for both ids when the body has no id", async () => {
    const rawBody = JSON.stringify({ title: "Signed" });

    const result = await parseWebhookRequest(
      inboundRequest(rawBody, { "webhook-id": "msg_9" }),
      context
    );

    expect(result.deliveryId).toBe("msg_9");
    expect(result.events[0]?.dedupKey).toBe("msg_9");
  });

  it("hashes ids too long for the dedup key column", async () => {
    const longId = "x".repeat(255);

    const result = await parseWebhookRequest(
      inboundRequest(JSON.stringify({ id: longId, title: "Long id" })),
      context
    );

    const hashed = `sha256:${sha256Hex(longId)}`;
    expect(result.deliveryId).toBe(hashed);
    expect(result.events[0]?.dedupKey).toBe(hashed);
    expect(result.events[0]?.item.key).toBe(
      `wh-${sha256Hex(hashed).slice(0, 12)}`
    );
  });

  it("adds metadata as a fenced JSON section", async () => {
    const rawBody = JSON.stringify({
      title: "With metadata",
      metadata: { note: "has ``` fence", n: 1 },
    });

    const result = await parseWebhookRequest(inboundRequest(rawBody), context);

    const sections = result.events[0]?.inlineItem?.sections ?? [];
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Metadata");
    expect(sections[0]?.markdown.startsWith("````json\n")).toBe(true);
    expect(sections[0]?.markdown.endsWith("\n````")).toBe(true);
    expect(sections[0]?.markdown).toContain('"note": "has ``` fence"');
    expect(result.events[0]?.extras).toEqual({
      metadata: { note: "has ``` fence", n: 1 },
    });
  });

  it("keeps an empty metadata object out of the extras and the item", async () => {
    const rawBody = JSON.stringify({ title: "Empty metadata", metadata: {} });

    const result = await parseWebhookRequest(inboundRequest(rawBody), context);

    expect(result.events[0]?.extras).toEqual({});
    expect(result.events[0]?.inlineItem?.sections).toEqual([]);
  });

  it("ignores an invalid body with a reason and no events", async () => {
    const rawBody = JSON.stringify({ description: "no title" });

    const result = await parseWebhookRequest(
      inboundRequest(rawBody, { "webhook-id": "msg_bad" }),
      context
    );

    expect(result.deliveryId).toBe("msg_bad");
    expect(result.events).toEqual([]);
    expect(result.ignoredReason).toMatch(INVALID_TITLE_REASON_RE);
  });

  it("ignores a body that is not JSON", async () => {
    const result = await parseWebhookRequest(
      inboundRequest("not json"),
      context
    );

    expect(result).toEqual({
      deliveryId: `sha256:${sha256Hex("not json")}`,
      eventType: WebhookTriggerType.Request,
      events: [],
      ignoredReason: "invalid_payload: body is not valid JSON",
    });
  });
});
