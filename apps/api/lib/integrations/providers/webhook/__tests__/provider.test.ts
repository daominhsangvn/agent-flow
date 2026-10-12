import {
  IntegrationDeliveryMode,
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  signStandardWebhook,
  verifyStandardWebhook,
} from "../../../inbound-auth";
import { toProviderSummary } from "../../../registry";
import { WebhookTriggerType } from "../inbound-event";
import { WebhookActionType } from "../post-action";
import { webhookProvider } from "../provider";
import { inboundRequest, makeWebhookContext } from "./webhook.test-helpers";

const WHSEC_RE = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

describe("webhookProvider definition", () => {
  it("wires the webhook trigger, webhook.post action and inline source", () => {
    expect(webhookProvider.key).toBe(IntegrationProviderKey.Webhook);
    expect(webhookProvider.triggers.map((trigger) => trigger.key)).toEqual([
      WebhookTriggerType.Request,
    ]);
    expect(webhookProvider.actions.map((action) => action.key)).toEqual([
      WebhookActionType.Post,
    ]);
    expect(webhookProvider.source?.resolveManual).toBeTypeOf("function");
    expect(webhookProvider.inbound?.deliveryModes).toEqual([
      IntegrationDeliveryMode.Webhook,
    ]);
  });

  it("declares an optional secret callback URL, signing secret and allowed callback hosts", () => {
    expect(
      webhookProvider.connection.fields.map((field) => [
        field.key,
        field.kind,
        field.required,
      ])
    ).toEqual([
      ["callbackUrl", IntegrationFieldKind.Secret, false],
      ["signingSecret", IntegrationFieldKind.Secret, false],
      ["allowedCallbackHosts", IntegrationFieldKind.StringList, false],
    ]);
    expect(
      webhookProvider.connection.fields.find(
        (field) => field.key === "callbackUrl"
      )?.label
    ).toBe("Default callback URL");
  });

  it("has no credential origin fields (its URLs are secrets)", () => {
    expect(webhookProvider.connection.credentialOriginFields).toBeUndefined();
    expect(toProviderSummary(webhookProvider).credentialOriginFields).toEqual(
      []
    );
  });

  it("generates Standard Webhooks inbound secrets", () => {
    const secret = webhookProvider.inbound?.generateSecret?.() ?? "";

    expect(secret).toMatch(WHSEC_RE);
  });

  it("round-trips a signed request through verify and parse", async () => {
    const inbound = webhookProvider.inbound;
    const secret = inbound?.generateSecret?.() ?? "";
    const rawBody = JSON.stringify({
      id: "evt-42",
      title: "Round trip",
      type: "feature",
      callbackUrl: "https://caller.example.com/callback",
      metadata: { ticket: 42 },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      "webhook-id": "msg_42",
      "webhook-timestamp": String(timestamp),
    });
    headers.set(
      "webhook-signature",
      signStandardWebhook("msg_42", timestamp, rawBody, secret)
    );
    expect(verifyStandardWebhook(rawBody, headers, secret).ok).toBe(true);

    const context = makeWebhookContext();
    const request = inboundRequest(
      rawBody,
      Object.fromEntries(headers.entries())
    );
    const verification = inbound?.verify?.(request, {
      connection: context.connection,
      inboundSecret: secret,
    });
    const parsed = await inbound?.parse?.(request, context);

    expect(verification).toEqual({ ok: true });
    expect(parsed?.deliveryId).toBe("msg_42");
    expect(parsed?.events.map((event) => event.dedupKey)).toEqual(["evt-42"]);
    const event = parsed?.events[0];
    expect(event?.attributes).toEqual({ type: "feature", labels: [] });
    expect(event?.extras).toEqual({
      callbackUrl: "https://caller.example.com/callback",
      metadata: { ticket: 42 },
    });
    expect(event?.inlineItem?.sections.map((section) => section.title)).toEqual(
      ["Metadata"]
    );
  });
});
