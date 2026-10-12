import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import type { InboundEvent } from "../../../types";
import { sha256Hex, WebhookTriggerType } from "../inbound-event";
import {
  fetchWebhookItem,
  resolveManualWebhookEvent,
  webhookRequestTrigger,
  webhookRequestTriggerConfigSchema,
} from "../request-trigger";
import { makeWebhookContext, NOW } from "./webhook.test-helpers";

const INVALID_TITLE_ERROR_RE = /^Invalid JSON payload: title: /;

function eventWithType(type: string | null): InboundEvent {
  return {
    triggerType: WebhookTriggerType.Request,
    dedupKey: "evt-1",
    occurredAt: NOW,
    actor: null,
    item: {
      provider: IntegrationProviderKey.Webhook,
      externalId: "evt-1",
      key: "evt-1",
      url: null,
      title: "T",
      container: null,
    },
    attributes: { type, labels: [] },
  };
}

describe("webhook.request trigger", () => {
  const { connection } = makeWebhookContext();

  function matches(event: InboundEvent, types: string[]): boolean {
    return webhookRequestTrigger.matches(
      event,
      webhookRequestTriggerConfigSchema.parse({ types }),
      connection
    );
  }

  it("defaults to accepting every type", () => {
    expect(webhookRequestTriggerConfigSchema.parse({})).toEqual({ types: [] });
    expect(matches(eventWithType(null), [])).toBe(true);
    expect(matches(eventWithType("bug"), [])).toBe(true);
  });

  it("matches configured types case-insensitively", () => {
    expect(matches(eventWithType("Feature"), ["feature", "bug"])).toBe(true);
  });

  it("rejects other types and requests without a type", () => {
    expect(matches(eventWithType("chore"), ["feature"])).toBe(false);
    expect(matches(eventWithType(null), ["feature"])).toBe(false);
  });

  it("offers a JSON manual run", () => {
    expect(webhookRequestTrigger.manualRun).toEqual({
      label: "JSON payload",
      placeholder: '{"title":"..."}',
    });
  });
});

describe("resolveManualWebhookEvent", () => {
  const context = makeWebhookContext();

  it("builds the same event shape as the inbound URL", async () => {
    const input = JSON.stringify({
      id: "evt-5",
      title: "Manual",
      type: "feature",
    });

    const event = await resolveManualWebhookEvent(
      context,
      input,
      WebhookTriggerType.Request
    );

    expect(event).toMatchObject({
      triggerType: WebhookTriggerType.Request,
      dedupKey: "evt-5",
      occurredAt: NOW,
      item: { externalId: "evt-5", key: "evt-5", title: "Manual" },
      attributes: { type: "feature" },
      extras: {},
      inlineItem: { title: "Manual", bodyMarkdown: "" },
    });
  });

  it("keeps the callbackUrl of a manual payload in the extras", async () => {
    const input = JSON.stringify({
      title: "Manual with callback",
      callbackUrl: "https://caller.example.com/callback",
    });

    const event = await resolveManualWebhookEvent(
      context,
      input,
      WebhookTriggerType.Request
    );

    expect(event.extras).toEqual({
      callbackUrl: "https://caller.example.com/callback",
    });
    expect(event.attributes).not.toHaveProperty("callbackUrl");
  });

  it("derives ids from the input hash when the payload has no id", async () => {
    const input = JSON.stringify({ title: "No id" });

    const event = await resolveManualWebhookEvent(
      context,
      input,
      WebhookTriggerType.Request
    );

    expect(event.dedupKey).toBe(`manual:${sha256Hex(input)}`);
  });

  it("rejects input that is not JSON with a user-facing error", async () => {
    await expect(
      resolveManualWebhookEvent(context, "PROJ-1", WebhookTriggerType.Request)
    ).rejects.toThrow("Invalid JSON payload: body is not valid JSON");
  });

  it("rejects JSON that does not match the schema", async () => {
    await expect(
      resolveManualWebhookEvent(
        context,
        JSON.stringify({ description: "missing title" }),
        WebhookTriggerType.Request
      )
    ).rejects.toThrow(INVALID_TITLE_ERROR_RE);
  });

  it("rejects other trigger types", async () => {
    await expect(
      resolveManualWebhookEvent(context, "{}", "webhook.other")
    ).rejects.toThrow(
      'Manual runs are not supported for trigger type "webhook.other".'
    );
  });
});

describe("fetchWebhookItem", () => {
  it("refuses: webhook items only exist inline", async () => {
    await expect(fetchWebhookItem()).rejects.toThrow(
      "Webhook items are carried inline"
    );
  });
});
